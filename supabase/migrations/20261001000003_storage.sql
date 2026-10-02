-- =====================================================================
-- 0003 STORAGE: buckets + object policies.
--   Public buckets hold brand imagery. Customer artwork and mockups are
--   private: a customer may only touch objects under "<their uid>/...";
--   staff with moderation/order rights can read them; everyone else uses
--   short-lived signed URLs minted server-side.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('products',      'products',      true,  10485760, array['image/jpeg','image/png','image/webp','image/avif','video/mp4','video/webm']),
  ('collections',   'collections',   true,  10485760, array['image/jpeg','image/png','image/webp','image/avif','video/mp4']),
  ('limited-drops', 'limited-drops', true,  10485760, array['image/jpeg','image/png','image/webp','image/avif','video/mp4']),
  ('archive',       'archive',       true,  10485760, array['image/jpeg','image/png','image/webp','image/avif']),
  ('avatars',       'avatars',       true,   2097152, array['image/jpeg','image/png','image/webp']),
  ('designs',       'designs',       false, 26214400, array['image/png','image/jpeg','image/webp','image/svg+xml']),
  ('mockups',       'mockups',       false, 10485760, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- Brand buckets: anyone reads (public buckets are served via CDN anyway),
-- catalog staff write.
create policy "brand media read" on storage.objects for select
  using (bucket_id in ('products','collections','limited-drops','archive','avatars'));
create policy "brand media write" on storage.objects for insert
  with check (bucket_id in ('products','collections','limited-drops','archive') and public.has_permission('catalog.write'));
create policy "brand media update" on storage.objects for update
  using (bucket_id in ('products','collections','limited-drops','archive') and public.has_permission('catalog.write'));
create policy "brand media delete" on storage.objects for delete
  using (bucket_id in ('products','collections','limited-drops','archive') and public.has_permission('catalog.write'));

-- Avatars: users manage files in their own folder.
create policy "own avatar write" on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own avatar delete" on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- Customer artwork & mockups: private, per-user folders.
create policy "own designs read" on storage.objects for select
  using (bucket_id in ('designs','mockups')
         and ((storage.foldername(name))[1] = auth.uid()::text
              or public.has_permission('moderation.review')
              or public.has_permission('orders.read')));
create policy "own designs upload" on storage.objects for insert
  with check (bucket_id in ('designs','mockups') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own designs delete" on storage.objects for delete
  using (bucket_id in ('designs','mockups') and (storage.foldername(name))[1] = auth.uid()::text);
