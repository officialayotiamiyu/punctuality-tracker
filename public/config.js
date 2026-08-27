// =====================================================================
//  Punctuality Tracker — configuration
//  EDIT THIS FILE with your real Supabase project values, then deploy.
// =====================================================================
window.APP_CONFIG = {
  // From your Supabase project: Dashboard → Settings → API
  // (Project URL + anon public key. The anon key is safe to expose —
  //  server-side RLS policies are the real security boundary.)
  supabaseUrl: 'https://srazzjyfgncimboekwaz.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyYXp6anlmZ25jaW1ib2Vrd2F6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc4MjI1MDQsImV4cCI6MjEwMzM5ODUwNH0.reWys4Kl9N4H8Nz0CSFtZ-f_DuiDKyfiwypJH-DIhGg',

  // ---- Punctuality rules ------------------------------------------------
  // Workday start in 24h format (local time of the phone/browser).
  shiftStart: '09:30',
  // Tolerance in minutes: an arrival after shiftStart + graceMinutes is LATE.
  graceMinutes: 10,

  // ---- Optional signup allowlist ---------------------------------------
  // Leave [] to let anyone create an employee account.
  // To lock signup to your team, list their exact emails, e.g.:
  //   allowedEmails: ['anna@yourcompany.com', 'bob@yourcompany.com']
  allowedEmails: []
};
