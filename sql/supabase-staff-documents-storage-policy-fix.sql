-- ############################################################################
-- !! WARNING (added 2026-10-31 audit) !!
-- This script predates the Supabase Auth migration and creates OPEN
-- "to anon" policies/grants. supabase-rls-lockdown.sql replaced them.
--   * Existing database: DO NOT re-run this file. It re-opens these tables
--     to anyone holding the public anon key.
--   * Fresh database: fine to run for the tables it creates, but run
--     supabase-rls-lockdown.sql afterward to close the anon access again.
-- ############################################################################

/* ============================================================================
   supabase-staff-documents-storage-policy-fix.sql

   Fixes: "new row violates row-level security policy" when uploading into
   the staff-documents bucket from a session that isn't the file's owner —
   specifically, Accounting generating a timesheet PDF into an EMPLOYEE's
   folder (see payroll-pdf-stub.js's generateFinalPdf()).

   Why this happens: this app uses custom auth, not Supabase Auth, so
   auth.uid() is always null server-side. If the staff-documents bucket's
   existing storage policy checks something like
   "(storage.foldername(name))[1] = auth.uid()::text", that check can never
   pass for anyone, no matter whose folder they're writing to — it just
   happened to only get hit now because this is the first upload path that
   writes into someone else's folder.

   Fix: add a permissive policy for the anon role scoped to this one bucket.
   Storage RLS policies are OR'ed together, so this doesn't touch or remove
   whatever policy is already there — it just adds another way to be
   allowed in, matching the permissive-to-anon pattern used by every table
   in this app (access control is enforced in the JS/UI layer, not by
   Postgres, throughout this project).

   Run this in Supabase → SQL Editor.
============================================================================ */

drop policy if exists "staff_documents_anon_all" on storage.objects;

create policy "staff_documents_anon_all"
on storage.objects
for all
to anon
using (bucket_id = 'staff-documents')
with check (bucket_id = 'staff-documents');
