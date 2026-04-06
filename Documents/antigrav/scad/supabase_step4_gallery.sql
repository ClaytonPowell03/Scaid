-- ============================================
-- scAId Database Setup — Step 4: Gallery
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. Create Gallery Table
create table if not exists public.gallery (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  author_name text default 'Anonymous',
  title text not null default 'Untitled Design',
  description text default '',
  scad_code text not null default '',
  thumbnail_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Setup RLS for Gallery Table
alter table public.gallery enable row level security;

-- Policy: Anyone can view gallery items
create policy "Gallery items are publicly accessible"
  on public.gallery for select
  using (true);

-- Policy: Authenticated users can insert their own gallery items
create policy "Users can publish to gallery"
  on public.gallery for insert
  with check (auth.role() = 'authenticated' and owner_id = auth.uid());

-- Policy: Users can update their own gallery items
create policy "Users can update their gallery items"
  on public.gallery for update
  using (auth.uid() = owner_id);

-- Policy: Users can delete their own gallery items
create policy "Users can delete their gallery items"
  on public.gallery for delete
  using (auth.uid() = owner_id);

-- 3. Create Storage Bucket for Gallery Thumbnails
insert into storage.buckets (id, name, public)
values ('gallery_thumbnails', 'gallery_thumbnails', true)
on conflict (id) do nothing;

-- 4. Setup Policies for Storage Bucket
-- Policy: Anyone can view gallery thumbnails
create policy "Gallery thumbnails are publicly accessible"
  on storage.objects for select
  using ( bucket_id = 'gallery_thumbnails' );

-- Policy: Signed in users can upload thumbnails
create policy "Users can upload gallery thumbnails"
  on storage.objects for insert
  with check (
    bucket_id = 'gallery_thumbnails' 
    and auth.role() = 'authenticated'
  );

-- Policy: Users can update their own thumbnails
create policy "Users can update their own gallery thumbnails"
  on storage.objects for update
  using (
    bucket_id = 'gallery_thumbnails' 
    and auth.uid() = owner
  );

-- Policy: Users can delete their own thumbnails
create policy "Users can delete their own gallery thumbnails"
  on storage.objects for delete
  using (
    bucket_id = 'gallery_thumbnails' 
    and auth.uid() = owner
  );
