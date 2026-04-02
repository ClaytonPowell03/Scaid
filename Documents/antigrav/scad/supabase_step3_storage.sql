-- ============================================
-- scAId Database Setup — Step 3: Storage (Avatars)
-- Run this to create the avatars bucket
-- ============================================

-- Create the storage bucket
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Enable RLS on storage.objects (if not already enabled)
alter table storage.objects enable row level security;

-- Policy: Anyone can view avatars
create policy "Avatars are publicly accessible"
  on storage.objects for select
  using ( bucket_id = 'avatars' );

-- Policy: Signed in users can upload avatars
create policy "Users can upload their own avatars"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars' 
    and auth.role() = 'authenticated'
  );

-- Policy: Users can update their own avatars
create policy "Users can update their own avatars"
  on storage.objects for update
  using (
    bucket_id = 'avatars' 
    and auth.uid() = owner
  );

-- Policy: Users can delete their own avatars
create policy "Users can delete their own avatars"
  on storage.objects for delete
  using (
    bucket_id = 'avatars' 
    and auth.uid() = owner
  );
