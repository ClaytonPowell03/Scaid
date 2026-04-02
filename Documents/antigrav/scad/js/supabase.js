/* ═══════════════════════════════════════════════════════
   scAId — Supabase Client
   Handles auth (Google OAuth) and project persistence.
   ═══════════════════════════════════════════════════════ */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

// Gracefully handle missing config (guest-only mode)
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });
}

export function isSupabaseConfigured() {
  return supabase !== null;
}

// ── Auth Helpers ─────────────────────────────────────

export async function signUpWithEmail(email, password) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signInWithEmail(email, password) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getUser() {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  if (!supabase) return null;
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function onAuthChange(callback) {
  if (!supabase) return { data: { subscription: { unsubscribe: () => {} } } };
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}

export async function uploadAvatar(file) {
  if (!supabase) throw new Error('Not authenticated');
  const user = await getUser();
  if (!user) throw new Error('Not authenticated');

  // Unique file name: user_id/timestamp.ext
  const fileExt = file.name.split('.').pop();
  const fileName = `${user.id}/${Date.now()}.${fileExt}`;
  const filePath = `${fileName}`;

  // Upload to avatars bucket
  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(filePath, file, { upsert: true });

  if (uploadError) throw uploadError;

  // Get public URL
  const { data } = supabase.storage
    .from('avatars')
    .getPublicUrl(filePath);

  const publicUrl = data.publicUrl;

  // Update user metadata
  const { error: updateError } = await supabase.auth.updateUser({
    data: { avatar_url: publicUrl }
  });

  if (updateError) throw updateError;
  return publicUrl;
}

// ── Project CRUD ─────────────────────────────────────

export async function createProject(name, code) {
  if (!supabase) throw new Error('Not authenticated');
  const user = await getUser();
  if (!user) throw new Error('Not authenticated');

  const { data, error } = await supabase
    .from('projects')
    .insert({ owner_id: user.id, name, code })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateProject(id, updates) {
  if (!supabase) throw new Error('Not authenticated');
  const { data, error } = await supabase
    .from('projects')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteProject(id) {
  if (!supabase) throw new Error('Not authenticated');
  const { error } = await supabase
    .from('projects')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function getMyProjects() {
  if (!supabase) return [];
  const user = await getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function getSharedProjects() {
  if (!supabase) return [];
  const user = await getUser();
  if (!user) return [];

  // Get project IDs shared with me
  const { data: shares, error: sharesError } = await supabase
    .from('project_shares')
    .select('project_id, can_edit')
    .eq('shared_with', user.id);

  if (sharesError) throw sharesError;
  if (!shares || shares.length === 0) return [];

  const projectIds = shares.map(s => s.project_id);
  const { data: projects, error: projectsError } = await supabase
    .from('projects')
    .select('*')
    .in('id', projectIds)
    .order('updated_at', { ascending: false });

  if (projectsError) throw projectsError;

  // Attach can_edit flag
  return (projects || []).map(p => ({
    ...p,
    can_edit: shares.find(s => s.project_id === p.id)?.can_edit || false,
    shared: true,
  }));
}

// ── Sharing ──────────────────────────────────────────

export async function shareProjectByEmail(projectId, email, canEdit = false) {
  if (!supabase) throw new Error('Not authenticated');
  const user = await getUser();
  if (!user) throw new Error('Not authenticated');

  // Look up user by email
  const { data: targetUserId, error: lookupError } = await supabase
    .rpc('get_user_id_by_email', { lookup_email: email });

  if (lookupError) throw lookupError;
  if (!targetUserId) throw new Error(`No account found for ${email}`);
  if (targetUserId === user.id) throw new Error('You cannot share with yourself');

  const { data, error } = await supabase
    .from('project_shares')
    .upsert({
      project_id: projectId,
      shared_with: targetUserId,
      shared_by: user.id,
      can_edit: canEdit,
    }, { onConflict: 'project_id,shared_with' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getProjectShares(projectId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('project_shares')
    .select('*')
    .eq('project_id', projectId);

  if (error) throw error;
  return data || [];
}

export async function removeShare(shareId) {
  if (!supabase) throw new Error('Not authenticated');
  const { error } = await supabase
    .from('project_shares')
    .delete()
    .eq('id', shareId);

  if (error) throw error;
}
