import { NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils'

// Lazy-initialized to avoid build-time crash when env vars aren't
// injected (e.g. on a fresh CI runner building a Docker image).
let _adminClient: SupabaseClient | null = null
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches
    const matched = (configs as Array<{ verify_token: string | null }>).some(
      (config) => {
        if (!config.verify_token) return false
        try {
          const decrypted = decrypt(config.verify_token)
          return decrypted === verifyToken
        } catch {
          return false
        }
      }
    )

    if (matched) {
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Always return 200 immediately to acknowledge receipt
  const body = await request.json()

  // Process asynchronously
  processWebhook(body).catch((error) => {
    console.error('Error processing webhook:', error)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const value = change.value

      // Handle status updates
      if (value.statuses) {
        for (const status of value.statuses) {
          await handleStatusUpdate(status)
        }
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id
      const { data: config, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)
        .single()

      if (configError || !config) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          config.user_id,
          decryptedAccessToken
        )
      }
    }
  }
}

async function handleStatusUpdate(status: {
  id: string
  status: string
  timestamp: string
  recipient_id: string
}) {
  // The messages table schema uses `message_id` (not whatsapp_message_id)
  // and has no `updated_at` column. Meta's status values (sent/delivered/
  // read/failed) already match our CHECK constraint.
  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status: status.status })
    .eq('message_id', status.id)

  if (error) {
    console.error('Error updating message status:', error)
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
  userId: string,
  accessToken: string
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Parse message content based on type
  const { contentText, mediaUrl } = await parseMessageContent(
    message,
    accessToken
  )

  // Find or create contact
  const contactRecord = await findOrCreateContact(
    userId,
    senderPhone,
    contactName
  )
  if (!contactRecord) return

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    userId,
    contactRecord.id
  )
  if (!conversation) return

  // Insert message — field names must match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // The messages.content_type CHECK constraint only allows:
  //   text, image, document, audio, video, location, template
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video', 'location', 'template',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'   // stickers are images
      : 'text'    // reaction, unknown → text fallback

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: 'delivered',
    created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
  })

  if (msgError) {
    console.error('Error inserting message:', msgError)
    return
  }

  // Update conversation
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${message.type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }
}

interface ParsedMessage {
  contentText: string | null
  mediaUrl: string | null
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<ParsedMessage> {
  // Verify a media asset exists on Meta's side and, if so, return the
  // app-local proxy URL that the inbox UI can load. We don't hand the
  // MIME type back because the messages schema has no column for it —
  // the proxy endpoint sets Content-Type from Meta at fetch time.
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  const empty: ParsedMessage = { contentText: null, mediaUrl: null }

  switch (message.type) {
    case 'text':
      return { contentText: message.text?.body || null, mediaUrl: null }

    case 'image':
      if (!message.image?.id) return empty
      return {
        contentText: message.image.caption || null,
        mediaUrl: await verifyAndBuildUrl(message.image.id),
      }

    case 'video':
      if (!message.video?.id) return empty
      return {
        contentText: message.video.caption || null,
        mediaUrl: await verifyAndBuildUrl(message.video.id),
      }

    case 'document':
      if (!message.document?.id) return empty
      return {
        contentText:
          message.document.caption || message.document.filename || null,
        mediaUrl: await verifyAndBuildUrl(message.document.id),
      }

    case 'audio':
      if (!message.audio?.id) return empty
      return {
        contentText: null,
        mediaUrl: await verifyAndBuildUrl(message.audio.id),
      }

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (!message.sticker?.id) return empty
      return {
        contentText: null,
        mediaUrl: await verifyAndBuildUrl(message.sticker.id),
      }

    case 'location': {
      const loc = message.location
      if (!loc) return empty
      const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
        .filter(Boolean)
        .join(' - ')
      return { contentText: locationText, mediaUrl: null }
    }

    case 'reaction':
      return { contentText: message.reaction?.emoji || null, mediaUrl: null }

    default:
      return {
        contentText: `[Unsupported message type: ${message.type}]`,
        mediaUrl: null,
      }
  }
}

async function findOrCreateContact(
  userId: string,
  phone: string,
  name: string
) {
  // Look up existing contacts for this user
  const { data: contacts, error: contactsError } = await supabaseAdmin()
    .from('contacts')
    .select('*')
    .eq('user_id', userId)

  if (contactsError) {
    console.error('Error fetching contacts:', contactsError)
    return null
  }

  // Use phonesMatch for flexible matching
  const existingContact = (contacts as Array<{ id: string; name: string | null; phone: string }> | null)
    ?.find((c) => phonesMatch(c.phone, phone))

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return existingContact
  }

  // Create new contact
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      user_id: userId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating contact:', createError)
    return null
  }

  return newContact
}

async function findOrCreateConversation(userId: string, contactId: string) {
  // Look for existing conversation
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('user_id', userId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing
  }

  // Create new conversation
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      user_id: userId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    return null
  }

  return newConv
}
