/* =========================================================
   إعدادات الاتصال بـ Supabase — ملاحظاتي
   ---------------------------------------------------------
   ✔ هذا الملف مصمم للنشر مع الموقع (Static Site / GitHub Pages)
     لأنه يحوي "المفتاح العام" (anon / publishable key) فقط،
     وهو مفتاح مقصود أن يكون عامًا، وحمايته تأتي من RLS في القاعدة.
   ✖ لا تضع هنا مفتاح service_role أو أي مفتاح سري (secret).
     مفتاح service_role يتجاوز الحماية ويجب ألا يغادر الخادم أبدًا.
   ---------------------------------------------------------
   مكان القيم: لوحة تحكم Supabase ← Project Settings ← API
     - Project URL
     - anon public (or publishable) key
   ========================================================= */
window.SUPABASE_CONFIG = {
  url: "https://nwsmrxdcoizvyyumtfau.supabase.co",
  anonKey: "sb_publishable_BLIex71cnw5jclG5E48eeA_GQR7RGMA",
};
