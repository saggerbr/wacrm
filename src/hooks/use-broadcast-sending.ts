'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, MessageTemplate } from '@/types';

interface AudienceConfig {
  type: 'all' | 'tags' | 'csv';
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, { type: 'static' | 'field'; value: string }>;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      return data ?? [];
    }

    if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
      const { data: contactTags, error: tagError } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError) throw new Error(`Failed to fetch contact tags: ${tagError.message}`);
      if (!contactTags || contactTags.length === 0) return [];

      const uniqueContactIds = [...new Set(contactTags.map((ct) => ct.contact_id))];

      const { data: contacts, error: contactError } = await supabase
        .from('contacts')
        .select('*')
        .in('id', uniqueContactIds);

      if (contactError) throw new Error(`Failed to fetch contacts: ${contactError.message}`);
      return contacts ?? [];
    }

    if (audience.type === 'csv' && audience.csvContacts) {
      return audience.csvContacts.map((c, i) => ({
        id: `csv-${i}`,
        user_id: '',
        phone: c.phone,
        name: c.name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
    }

    return [];
  }

  function resolveVariables(
    variables: Record<string, { type: 'static' | 'field'; value: string }>,
    contact: Contact
  ): string[] {
    return Object.keys(variables)
      .sort()
      .map((key) => {
        const v = variables[key];
        if (v.type === 'static') return v.value;
        const fieldMap: Record<string, string | undefined> = {
          name: contact.name,
          phone: contact.phone,
          email: contact.email,
          company: contact.company,
        };
        return fieldMap[v.value] ?? '';
      });
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // Step 1: Resolve audience contacts
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // Step 2: Create broadcast record
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
          },
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(`Failed to create broadcast: ${broadcastError?.message}`);
      }

      // Step 3: Create broadcast recipients in batches
      setProgress(20);
      const BATCH_SIZE = 50;
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);

        // Fail-fast: if we continued on error, the broadcast would only
        // reach a subset of intended recipients while the UI reports
        // success. Better to abort and surface the DB error to the user
        // so they can retry with a consistent state.
        if (recipientError) {
          throw new Error(
            `Failed to insert recipient batch (rows ${i}-${i + batch.length}): ${recipientError.message}`
          );
        }
      }

      // Step 4: Fetch recipients and send via API in batches
      setProgress(30);
      const { data: recipients, error: recipientsFetchError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcast.id);

      if (recipientsFetchError || !recipients) {
        throw new Error('Failed to fetch broadcast recipients');
      }

      let sentCount = 0;
      let failedCount = 0;
      const totalRecipients = recipients.length;

      for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
        const batch = recipients.slice(i, i + BATCH_SIZE);
        const phoneNumbers = batch
          .map((r) => r.contact?.phone)
          .filter(Boolean) as string[];

        if (phoneNumbers.length === 0) continue;

        // Resolve template params from the first contact in batch for static values
        const templateParams = batch.map((r) => {
          if (r.contact) {
            return resolveVariables(payload.variables, r.contact);
          }
          return [];
        });

        try {
          const res = await fetch('/api/whatsapp/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              phone_numbers: phoneNumbers,
              template_name: payload.template.name,
              template_language: payload.template.language ?? 'en_US',
              template_params: templateParams[0] ?? [],
            }),
          });

          const data = await res.json();

          if (!res.ok) {
            throw new Error(data.error || 'Broadcast API request failed');
          }

          // Update recipient statuses. Bulk-update all "sent" in one
          // query; individual updates for failures because they carry
          // per-recipient error messages. Previously this was one UPDATE
          // per recipient (50 round-trips per batch), which made large
          // broadcasts quadratic.
          if (data.results) {
            const sentIds: string[] = [];
            const failedResults: Array<{ id: string; error: string | null }> = [];

            for (let j = 0; j < data.results.length; j++) {
              const result = data.results[j];
              const recipient = batch[j];
              if (!recipient) continue;

              if (result.status === 'sent') {
                sentIds.push(recipient.id);
                sentCount++;
              } else {
                failedResults.push({ id: recipient.id, error: result.error ?? null });
                failedCount++;
              }
            }

            if (sentIds.length > 0) {
              const { error } = await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'sent',
                  sent_at: new Date().toISOString(),
                  error_message: null,
                })
                .in('id', sentIds);
              if (error) console.error('Failed to mark batch sent:', error);
            }

            // Failures need individual writes because error_message differs.
            // Keeping the awaits sequential so we don't blow up Supabase
            // with 50 parallel write connections on large broadcasts.
            for (const fail of failedResults) {
              const { error } = await supabase
                .from('broadcast_recipients')
                .update({ status: 'failed', error_message: fail.error })
                .eq('id', fail.id);
              if (error) console.error('Failed to mark recipient failed:', error);
            }
          }
        } catch (err) {
          // API itself failed — mark the whole batch as failed in a
          // single query with the same error message for everyone.
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          const batchIds = batch.map((r) => r.id);
          failedCount += batchIds.length;

          if (batchIds.length > 0) {
            const { error: updateError } = await supabase
              .from('broadcast_recipients')
              .update({ status: 'failed', error_message: errorMessage })
              .in('id', batchIds);
            if (updateError) {
              console.error('Failed to mark batch failed:', updateError);
            }
          }
        }

        const progressPct = 30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);
      }

      // Step 5: Update broadcast with final counts
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await supabase
        .from('broadcasts')
        .update({
          status: finalStatus,
          sent_count: sentCount,
          failed_count: failedCount,
        })
        .eq('id', broadcast.id);

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
