(function () {
  "use strict";

  /* =========================================================
     1) الاتصال بـ Supabase (يحل محل التخزين المحلي)
     ========================================================= */
  const KEYS = { theme: "maloohati:theme:v1" };
  const AUTH_STORAGE_KEY = "maloohati:auth";

  const storage = {
    read(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) {
        console.warn("تعذّرت قراءة البيانات المحلية:", err);
        return fallback;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        console.warn("تعذّر حفظ البيانات المحلية:", err);
        return false;
      }
    },
  };

  const CONFIG = window.SUPABASE_CONFIG || {};
  let db = null;
  let configStatus = "ok"; // ok | missing-config | sdk-missing

  function looksPlaceholder(value) {
    const v = String(value || "").trim();
    return !v || /YOUR_PROJECT|PASTE_YOUR|PUT_|CHANGE_ME|xxxx/i.test(v);
  }

  (function connect() {
    if (!window.supabase || !window.supabase.createClient) {
      configStatus = "sdk-missing";
      return;
    }
    if (looksPlaceholder(CONFIG.url) || looksPlaceholder(CONFIG.anonKey)) {
      configStatus = "missing-config";
      return;
    }
    try {
      db = window.supabase.createClient(String(CONFIG.url).trim(), String(CONFIG.anonKey).trim(), {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: AUTH_STORAGE_KEY,
        },
      });
      configStatus = "ok";
    } catch (err) {
      console.error("تعذّر تهيئة Supabase:", err);
      configStatus = "sdk-missing";
    }
  })();

  const M = {
    notConfigured: "لم يتم ربط الموقع بـ Supabase بعد — عدّل ملف supabase-config.js",
    sdkMissing: "تعذّر تحميل مكتبة Supabase — تحقق من الاتصال بالإنترنت",
    noTable: "الجدول غير موجود بعد — نفّذ ملف supabase-schema.sql من لوحة تحكم Supabase",
    forbidden: "غير مصرح لك بالوصول إلى هذه البيانات (RLS)",
    offline: "لا يوجد اتصال بالإنترنت",
    serverDown: "تعذّر الاتصال بخادم Supabase — تحقق من الإنترنت وعنوان المشروع",
  };

  function serverErrorMessage(err) {
    const msg = String((err && (err.message || err.error_description || err.error)) || "");
    if (typeof navigator !== "undefined" && navigator.onLine === false) return M.offline;
    if (/does not exist|schema cache/i.test(msg)) return M.noTable;
    if (/row-level security|permission denied/i.test(msg)) return M.forbidden;
    if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(msg)) return M.serverDown;
    if (err && err.code === "PGRST116") return "لم يعد هذا العنصر موجودًا";
    if (msg) return msg;
    return "حدث خطأ غير متوقع، أعد المحاولة";
  }

  const AUTH_ERRORS = {
    "Invalid login credentials": ["loginPassword", "البريد الإلكتروني أو كلمة المرور غير صحيحة"],
    "User already registered": ["regEmail", "هذا البريد مسجّل مسبقًا، جرّب تسجيل الدخول"],
    "Email not confirmed": ["loginPassword", "لم يتم تأكيد بريدك بعد — افتح رابط التأكيد المرسل إليك"],
    "Password should be at least 6 characters": ["regPassword", "كلمة المرور يجب ألا تقل عن 6 خانات"],
    "Signup requires a valid password": ["regPassword", "كلمة المرور غير صالحة"],
    "Unable to validate email address: invalid format": ["regEmail", "صيغة البريد الإلكتروني غير صحيحة"],
    "Email rate limit exceeded": [null, "محاولات كثيرة على البريد — أعد المحاولة بعد قليل"],
    "Security purposes": [null, "انتظر قليلًا قبل طلب رسالة جديدة"],
    "should be different": ["newPassPassword", "كلمة المرور الجديدة يجب أن تختلف عن القديمة"],
  };

  function handleAuthError(error, formId) {
    const msg = String((error && error.message) || "");
    for (const key of Object.keys(AUTH_ERRORS)) {
      if (msg.indexOf(key) !== -1) {
        const [field, text] = AUTH_ERRORS[key];
        const form = document.getElementById(formId);
        const fieldEl = field ? document.getElementById(field) : null;
        // اعرض الخطأ على الحقل فقط إن كان داخل هذا النموذج، وإلا إشعارًا عامًا
        if (fieldEl && form && form.contains(fieldEl)) setFieldError(field, text);
        else toast(text, "error");
        return;
      }
    }
    if (/rate limit|too many requests/i.test(msg)) {
      toast("محاولات كثيرة جدًا — انتظر دقيقة ثم أعد المحاولة", "error");
      return;
    }
    toast(serverErrorMessage(error), "error");
  }

  function requireConfig() {
    if (configStatus === "ok" && db) return true;
    $("#configBanner").classList.remove("hidden");
    toast(configStatus === "sdk-missing" ? M.sdkMissing : M.notConfigured, "error");
    return false;
  }

  /* =========================================================
     2) الطبقة: الملاحظات عبر Supabase (جلب/إضافة/تعديل/حذف)
     ========================================================= */
  function rowToNote(row) {
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title || "",
      body: row.body || "",
      color: row.color || "plain",
      pinned: Boolean(row.pinned),
      favorite: Boolean(row.favorite),
      createdAt: Date.parse(row.created_at) || Date.now(),
      updatedAt: Date.parse(row.updated_at) || Date.now(),
      deletedAt: row.deleted_at ? Date.parse(row.deleted_at) : null,
    };
  }

  const notesApi = {
    /** جلب ملاحظات المستخدم الحالي فقط */
    async list() {
      const { data, error } = await db
        .from("notes")
        .select("*")
        .eq("user_id", currentUser.id)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(rowToNote);
    },
    /** إضافة ملاحظة جديدة */
    async create(payload) {
      const { data, error } = await db
        .from("notes")
        .insert(Object.assign({ user_id: currentUser.id }, payload))
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    /** تعديل ملاحظة (RLS يمنع غير المالك) */
    async update(id, patch) {
      const { data, error } = await db
        .from("notes")
        .update(patch)
        .eq("id", id)
        .eq("user_id", currentUser.id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    /** حذف نهائي */
    async remove(id) {
      const { error } = await db
        .from("notes")
        .delete()
        .eq("id", id)
        .eq("user_id", currentUser.id);
      if (error) throw error;
      return true;
    },
  };

  function cacheReplace(row) {
    const note = rowToNote(row);
    const index = notes.findIndex((n) => n.id === note.id);
    if (index >= 0) notes[index] = note;
    else notes.unshift(note);
    return note;
  }

  /* =========================================================
     3) الحالة العامة
     ========================================================= */
  let currentUser = null;
  let notes = [];

  const ui = {
    filter: "all",
    query: "",
    editingId: null,
    editingColor: "plain",
    isNewDraft: false,
    autoSaveTimer: null,
    confirmAction: null,
    saving: false,
    loading: false,
  };

  /* =========================================================
     4) أدوات DOM
     ========================================================= */
  const $ = (sel) => document.querySelector(sel);

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(message, type) {
    const container = $("#toastContainer");
    const kind = type || "success";
    const el = document.createElement("div");
    el.className = "toast toast-" + kind;
    el.innerHTML =
      '<svg class="icon"><use href="#i-' + (kind === "error" ? "close" : kind === "info" ? "info" : "check") + '"/></svg>' +
      "<span>" + esc(message) + "</span>";
    container.appendChild(el);
    window.setTimeout(() => {
      el.classList.add("out");
      window.setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = Boolean(busy);
    button.classList.toggle("is-loading", Boolean(busy));
  }

  /* =========================================================
     5) الوضع الليلي
     ========================================================= */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    storage.write(KEYS.theme, theme);
  }

  function initTheme() {
    const saved = storage.read(KEYS.theme, null);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(saved === "dark" || saved === "light" ? saved : prefersDark ? "dark" : "light");
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(current);
  }

  /* =========================================================
     6) المصادقة (Supabase Auth)
     ========================================================= */
  function isEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  function setFieldError(inputId, message) {
    const input = document.getElementById(inputId);
    const error = document.getElementById(inputId + "Error");
    const field = input ? input.closest(".field") : null;
    if (field) field.classList.toggle("has-error", Boolean(message));
    if (error) error.textContent = message || "";
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function clearFormErrors(formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.querySelectorAll(".field").forEach((f) => f.classList.remove("has-error"));
    form.querySelectorAll(".field-error").forEach((e) => (e.textContent = ""));
  }

  async function handleRegister(event) {
    event.preventDefault();
    if (!requireConfig()) return;
    clearFormErrors("registerForm");

    const name = $("#regName").value.trim();
    const email = $("#regEmail").value.trim().toLowerCase();
    const password = $("#regPassword").value;
    const confirm = $("#regConfirm").value;
    let valid = true;

    if (name.length < 2) { setFieldError("regName", "يرجى إدخال اسم صحيح (حرفان على الأقل)"); valid = false; }
    if (!isEmail(email)) { setFieldError("regEmail", "صيغة البريد الإلكتروني غير صحيحة"); valid = false; }
    if (password.length < 6) { setFieldError("regPassword", "كلمة المرور يجب ألا تقل عن 6 خانات"); valid = false; }
    if (password !== confirm) { setFieldError("regConfirm", "كلمتا المرور غير متطابقتين"); valid = false; }
    if (!valid) return;

    const button = event.submitter || $("#registerForm button[type=submit]");
    setBusy(button, true);
    try {
      const { data, error } = await db.auth.signUp({
        email: email,
        password: password,
        options: {
          data: { name: name },
          emailRedirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) { handleAuthError(error, "registerForm"); return; }

      $("#registerForm").reset();
      resetStrength();

      if (data && data.session && data.user) {
        toast("تم إنشاء حسابك بنجاح، أهلًا بك " + name.split(" ")[0] + " 👋");
        await enterApp(data.user);
      } else {
        toast("تم إرسال رابط تأكيد إلى بريدك — افتحه لتفعيل الحساب ثم سجّل دخولك", "info");
        switchAuthTab("login");
        $("#loginEmail").value = email;
        $("#loginPassword").focus();
      }
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (!requireConfig()) return;
    clearFormErrors("loginForm");

    const email = $("#loginEmail").value.trim().toLowerCase();
    const password = $("#loginPassword").value;
    let valid = true;

    if (!isEmail(email)) { setFieldError("loginEmail", "صيغة البريد الإلكتروني غير صحيحة"); valid = false; }
    if (!password) { setFieldError("loginPassword", "يرجى إدخال كلمة المرور"); valid = false; }
    if (!valid) return;

    const button = event.submitter || $("#loginForm button[type=submit]");
    setBusy(button, true);
    try {
      const { data, error } = await db.auth.signInWithPassword({ email: email, password: password });
      if (error) { handleAuthError(error, "loginForm"); return; }
      $("#loginForm").reset();
      await enterApp(data.user);
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function handleReset(event) {
    event.preventDefault();
    if (!requireConfig()) return;
    clearFormErrors("resetForm");

    const email = $("#resetEmail").value.trim().toLowerCase();
    if (!isEmail(email)) { setFieldError("resetEmail", "صيغة البريد الإلكتروني غير صحيحة"); return; }

    const button = event.submitter || $("#resetForm button[type=submit]");
    setBusy(button, true);
    try {
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
      if (error) { handleAuthError(error, "resetForm"); return; }
      toast("تم إرسال رابط استعادة كلمة المرور إلى بريدك — افتحه ثم عيّن كلمة مرور جديدة", "info");
      showAuthView("login");
      $("#loginEmail").value = email;
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function handleNewPassword(event) {
    event.preventDefault();
    if (!requireConfig()) return;
    clearFormErrors("newPassForm");

    const password = $("#newPassPassword").value;
    const confirm = $("#newPassConfirm").value;
    let valid = true;

    if (password.length < 6) { setFieldError("newPassPassword", "كلمة المرور يجب ألا تقل عن 6 خانات"); valid = false; }
    if (password !== confirm) { setFieldError("newPassConfirm", "كلمتا المرور غير متطابقتين"); valid = false; }
    if (!valid) return;

    const button = event.submitter || $("#newPassForm button[type=submit]");
    setBusy(button, true);
    try {
      const { data, error } = await db.auth.updateUser({ password: password });
      if (error) { handleAuthError(error, "newPassForm"); return; }
      try { window.history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) { void e; }
      $("#newPassForm").reset();
      toast("تم تغيير كلمة المرور بنجاح 🎉");
      await enterApp(data.user);
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function handleLogout() {
    closeEditor(true);
    try {
      if (db) await db.auth.signOut();
    } catch (err) {
      console.warn("signOut:", err);
    }
    currentUser = null;
    notes = [];
    showAuth();
    toast("تم تسجيل خروجك بأمان", "info");
  }

  /* =========================================================
     7) التنقل بين الشاشات
     ========================================================= */
  function showAuth() {
    $("#appView").classList.add("hidden");
    $("#authView").classList.remove("hidden");
    window.setTimeout(() => $("#loginEmail").focus(), 60);
  }

  function showApp() {
    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
  }

  function resetFilters() {
    ui.filter = "all";
    ui.query = "";
    $("#searchInput").value = "";
    $("#clearSearch").classList.add("hidden");
    document.querySelectorAll(".chip").forEach((chip) => {
      const active = chip.dataset.filter === "all";
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-selected", String(active));
    });
  }

  async function enterApp(user) {
    if (!user) return;
    if (currentUser && currentUser.id === user.id && !$("#appView").classList.contains("hidden")) return;

    const meta = user.user_metadata || {};
    currentUser = {
      id: user.id,
      name: String(meta.name || (user.email || "").split("@")[0] || "مستخدم").trim(),
      email: user.email || "",
    };

    $("#userAvatar").textContent = currentUser.name.charAt(0) || "؟";
    $("#menuName").textContent = currentUser.name;
    $("#menuEmail").textContent = currentUser.email;

    resetFilters();
    showApp();
    await loadNotes();
  }

  const AUTH_FORMS = {
    login: "loginForm",
    register: "registerForm",
    reset: "resetForm",
    newpass: "newPassForm",
  };

  function showAuthView(view) {
    const isMain = view === "login" || view === "register";
    $("#authTabs").classList.toggle("hidden", !isMain);

    Object.keys(AUTH_FORMS).forEach((key) => {
      const id = AUTH_FORMS[key];
      const active = key === view;
      document.getElementById(id).classList.toggle("hidden", !active);
      if (!active) clearFormErrors(id);
    });

    if (isMain) {
      const isRegister = view === "register";
      $("#tabLogin").classList.toggle("is-active", !isRegister);
      $("#tabRegister").classList.toggle("is-active", isRegister);
      $("#tabLogin").setAttribute("aria-selected", String(!isRegister));
      $("#tabRegister").setAttribute("aria-selected", String(isRegister));
      $("#authTabs").dataset.active = isRegister ? "register" : "login";
    }
  }

  function switchAuthTab(target) {
    showAuthView(target === "register" ? "register" : "login");
  }

  /* =========================================================
     8) تحميل وعرض الملاحظات
     ========================================================= */
  async function loadNotes() {
    if (!currentUser || !db) return;
    ui.loading = true;
    $("#notesGrid").classList.add("hidden");
    $("#emptyState").classList.add("hidden");
    $("#resultInfo").textContent = "جارٍ مزامنة ملاحظاتك...";
    try {
      notes = await notesApi.list();
    } catch (err) {
      notes = [];
      toast(serverErrorMessage(err), "error");
    } finally {
      ui.loading = false;
      render();
    }
  }

  function countOf(kind) {
    if (kind === "all") return notes.filter((n) => !n.deletedAt).length;
    if (kind === "trash") return notes.filter((n) => n.deletedAt).length;
    if (kind === "pinned") return notes.filter((n) => n.pinned && !n.deletedAt).length;
    if (kind === "favorites") return notes.filter((n) => n.favorite && !n.deletedAt).length;
    return 0;
  }

  function visibleNotes() {
    const q = ui.query.trim().toLowerCase();
    return notes
      .filter((n) => (ui.filter === "trash" ? Boolean(n.deletedAt) : !n.deletedAt))
      .filter((n) => {
        if (ui.filter === "pinned") return n.pinned;
        if (ui.filter === "favorites") return n.favorite;
        return true;
      })
      .filter((n) => !q || (n.title + " " + n.body).toLowerCase().includes(q))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  const ARABIC_PLURALS = {
    minute: ["دقيقة", "دقيقتان", "دقائق", "دقيقة"],
    hour: ["ساعة", "ساعتان", "ساعات", "ساعة"],
    day: ["يوم", "يومان", "أيام", "يوم"],
    month: ["شهر", "شهران", "أشهر", "شهرًا"],
    year: ["سنة", "سنتان", "سنوات", "سنة"],
  };

  function plural(kind, count) {
    const set = ARABIC_PLURALS[kind];
    if (count === 1) return set[0];
    if (count === 2) return set[1];
    if (count >= 3 && count <= 10) return set[2] + " " + count;
    return set[3] + " " + count;
  }

  function timeAgo(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "الآن";
    if (minutes < 60) return "منذ " + plural("minute", minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return "منذ " + plural("hour", hours);
    const days = Math.floor(hours / 24);
    if (days < 30) return "منذ " + plural("day", days);
    const months = Math.floor(days / 30);
    if (months < 12) return "منذ " + plural("month", months);
    return "منذ " + plural("year", Math.floor(months / 12));
  }

  function noteCardHTML(note, index) {
    const delay = Math.min(index, 10) * 35;
    const title = note.title.trim() || "بلا عنوان";
    const preview = note.body.trim()
      ? esc(note.body.trim().replace(/\s+/g, " ").slice(0, 240))
      : "لا يوجد نص — اضغط للكتابة...";
    const inTrash = Boolean(note.deletedAt);

    let actions = "";
    if (inTrash) {
      actions =
        '<button class="note-action" data-action="restore" title="استعادة" aria-label="استعادة الملاحظة"><svg class="icon"><use href="#i-restore"/></svg></button>' +
        '<button class="note-action danger" data-action="purge" title="حذف نهائي" aria-label="حذف نهائي"><svg class="icon"><use href="#i-trash"/></svg></button>';
    } else {
      actions =
        '<button class="note-action pin' + (note.pinned ? " is-on" : "") + '" data-action="pin" title="' + (note.pinned ? "إلغاء التثبيت" : "تثبيت") + '" aria-label="تثبيت"><svg class="icon"><use href="#i-pin"/></svg></button>' +
        '<button class="note-action star' + (note.favorite ? " is-on" : "") + '" data-action="favorite" title="' + (note.favorite ? "إزالة من المفضلة" : "إضافة للمفضلة") + '" aria-label="مفضلة"><svg class="icon"><use href="#i-star"/></svg></button>' +
        '<button class="note-action danger" data-action="delete" title="حذف" aria-label="حذف"><svg class="icon"><use href="#i-trash"/></svg></button>';
    }

    return (
      '<article class="note ' + (note.color === "plain" || !note.color ? "plain" : "") + '" data-color="' + esc(note.color || "plain") + '" data-id="' + esc(note.id) + '" style="animation-delay:' + delay + 'ms" tabindex="0" role="button" aria-label="فتح الملاحظة ' + esc(title) + '">' +
      '<div class="note-top">' +
      '<h3 class="note-title">' + esc(title) + "</h3>" +
      (note.pinned && !inTrash ? '<span class="note-pin" title="مثبتة"><svg class="icon"><use href="#i-pin"/></svg></span>' : "") +
      "</div>" +
      '<p class="note-body' + (note.body.trim() ? "" : " is-empty") + '">' + preview + "</p>" +
      '<div class="note-foot">' +
      '<time class="note-time" datetime="' + new Date(note.updatedAt).toISOString() + '">' + timeAgo(note.updatedAt) + "</time>" +
      '<div class="note-actions">' + actions + "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function emptyStateConfig() {
    if (ui.query) {
      return {
        title: "لا توجد نتائج مطابقة",
        text: "لم نعثر على ملاحظات تطابق «" + ui.query + "». جرّب كلمات بحث أخرى.",
        action: "مسح البحث",
        handler: clearSearch,
      };
    }
    if (ui.filter === "trash") {
      return { title: "سلة المحذوفات فارغة", text: "الملاحظات المحذوفة تظهر هنا قبل الحذف النهائي.", action: "عرض كل الملاحظات", handler: () => setFilter("all") };
    }
    if (ui.filter === "pinned") {
      return { title: "لا توجد ملاحظات مثبتة", text: "ثبّت الملاحظات المهمة لتظهر هنا في المقدمة دائمًا.", action: "عرض كل الملاحظات", handler: () => setFilter("all") };
    }
    if (ui.filter === "favorites") {
      return { title: "لا توجد ملاحظات مفضلة", text: "اضغط على النجمة في أي ملاحظة لإضافتها إلى المفضلة.", action: "عرض كل الملاحظات", handler: () => setFilter("all") };
    }
    return { title: "لا توجد ملاحظات بعد", text: "ابدأ بتدوين أول فكرة لك الآن، وستظهر هنا مباشرة.", action: "إنشاء ملاحظة", handler: openNewNote };
  }

  function render() {
    if (ui.loading) return;
    const list = visibleNotes();

    $("#countAll").textContent = countOf("all");
    $("#countPinned").textContent = countOf("pinned");
    $("#countFav").textContent = countOf("favorites");
    $("#countTrash").textContent = countOf("trash");
    $("#statNotes").textContent = countOf("all");
    $("#statPinned").textContent = countOf("pinned");
    $("#statFav").textContent = countOf("favorites");

    const grid = $("#notesGrid");
    grid.innerHTML = list.map(noteCardHTML).join("");

    const info = $("#resultInfo");
    if (ui.query) info.textContent = "نتائج البحث: " + list.length;
    else if (ui.filter === "all") info.textContent = "إجمالي " + countOf("all") + " ملاحظة";
    else info.textContent = list.length + " في هذا القسم";

    const empty = list.length === 0;
    $("#emptyState").classList.toggle("hidden", !empty);
    grid.classList.toggle("hidden", empty);
    if (empty) {
      const cfg = emptyStateConfig();
      $("#emptyTitle").textContent = cfg.title;
      $("#emptyText").textContent = cfg.text;
      const btn = $("#emptyAction");
      btn.querySelector("span").textContent = cfg.action;
      btn.querySelector("use").setAttribute("href", ui.query ? "#i-search" : "#i-plus");
      btn.onclick = cfg.handler;
    }
  }

  function setFilter(filter) {
    ui.filter = filter;
    document.querySelectorAll(".chip").forEach((chip) => {
      const active = chip.dataset.filter === filter;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-selected", String(active));
    });
    render();
  }

  function clearSearch() {
    ui.query = "";
    $("#searchInput").value = "";
    $("#clearSearch").classList.add("hidden");
    render();
  }

  /* =========================================================
     9) عمليات CRUD (عبر Supabase)
     ========================================================= */
  function findNote(id) {
    return notes.find((n) => n.id === id && (!currentUser || n.userId === currentUser.id));
  }

  async function softDeleteNote(id) {
    if (!requireConfig()) return;
    try {
      const row = await notesApi.update(id, { deleted_at: new Date().toISOString(), pinned: false });
      cacheReplace(row);
      render();
      toast("تم نقل الملاحظة إلى سلة المحذوفات", "info");
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    }
  }

  async function restoreNote(id) {
    if (!requireConfig()) return;
    try {
      const row = await notesApi.update(id, { deleted_at: null });
      cacheReplace(row);
      render();
      toast("تمت استعادة الملاحظة");
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    }
  }

  async function purgeNote(id) {
    if (!requireConfig()) return;
    try {
      await notesApi.remove(id);
      notes = notes.filter((n) => n.id !== id);
      render();
      toast("تم الحذف النهائي للملاحظة", "info");
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    }
  }

  async function toggleFlag(id, flag) {
    if (!requireConfig()) return;
    const note = findNote(id);
    if (!note) return;
    try {
      const row = await notesApi.update(id, { [flag]: !note[flag] });
      cacheReplace(row);
      render();
    } catch (err) {
      toast(serverErrorMessage(err), "error");
    }
  }

  /* =========================================================
     10) المحرر + الحفظ التلقائي
     ========================================================= */
  function openNewNote() {
    if (!requireConfig()) return;
    ui.editingId = null;
    ui.isNewDraft = true;
    ui.editingColor = "plain";
    $("#editorTitle").textContent = "ملاحظة جديدة";
    $("#noteTitleInput").value = "";
    $("#noteBodyInput").value = "";
    $("#deleteFromEditor").classList.add("hidden");
    $("#autoSaveHint").classList.remove("show");
    setActiveSwatch("plain");
    openModal();
    window.setTimeout(() => $("#noteTitleInput").focus(), 80);
  }

  function openExistingNote(id) {
    const note = findNote(id);
    if (!note || note.deletedAt) return;
    ui.editingId = note.id;
    ui.isNewDraft = false;
    ui.editingColor = note.color || "plain";
    $("#editorTitle").textContent = "تعديل الملاحظة";
    $("#noteTitleInput").value = note.title;
    $("#noteBodyInput").value = note.body;
    $("#deleteFromEditor").classList.remove("hidden");
    $("#autoSaveHint").textContent = "آخر تعديل: " + timeAgo(note.updatedAt);
    $("#autoSaveHint").classList.add("show");
    setActiveSwatch(ui.editingColor);
    openModal();
  }

  function openModal() {
    $("#noteModal").classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  async function closeEditor(force) {
    const title = $("#noteTitleInput").value.trim();
    const body = $("#noteBodyInput").value.trim();
    const hasContent = Boolean(title || body);

    if (!force && ui.isNewDraft && ui.editingId === null && !hasContent) {
      closeModal();
      return;
    }
    if (!force && hasContent) await commitEditor({ silent: true });
    closeModal();
  }

  function closeModal() {
    window.clearTimeout(ui.autoSaveTimer);
    ui.autoSaveTimer = null;
    ui.editingId = null;
    ui.isNewDraft = false;
    $("#noteModal").classList.add("hidden");
    document.body.style.overflow = "";
  }

  function setActiveSwatch(color) {
    document.querySelectorAll("#colorRow .swatch").forEach((s) => {
      s.classList.toggle("is-active", s.dataset.color === color);
    });
  }

  async function commitEditor(options) {
    const opts = options || {};
    if (ui.saving) return null;

    const title = $("#noteTitleInput").value.trim();
    const body = $("#noteBodyInput").value.trim();

    if (!title && !body) {
      if (!opts.silent) toast("لا يمكن حفظ ملاحظة فارغة", "error");
      return null;
    }
    if (!requireConfig()) return null;

    ui.saving = true;
    try {
      let note;
      if (ui.editingId) {
        const existing = findNote(ui.editingId);
        if (!existing) return null;
        const row = await notesApi.update(ui.editingId, {
          title: title,
          body: body,
          color: ui.editingColor,
        });
        note = cacheReplace(row);
      } else {
        const row = await notesApi.create({
          title: title,
          body: body,
          color: ui.editingColor,
        });
        note = rowToNote(row);
        notes.unshift(note);
        ui.editingId = note.id;
        ui.isNewDraft = false;
        $("#editorTitle").textContent = "تعديل الملاحظة";
        $("#deleteFromEditor").classList.remove("hidden");
      }
      render();
      return note;
    } catch (err) {
      toast(serverErrorMessage(err), "error");
      return null;
    } finally {
      ui.saving = false;
    }
  }

  function scheduleAutoSave() {
    if (configStatus !== "ok") return;
    window.clearTimeout(ui.autoSaveTimer);
    ui.autoSaveTimer = window.setTimeout(async () => {
      if ($("#noteModal").classList.contains("hidden") || ui.saving) return;
      const title = $("#noteTitleInput").value.trim();
      const body = $("#noteBodyInput").value.trim();
      if (!title && !body) return;
      const saved = await commitEditor({ silent: true });
      if (saved) flashSaved("تم الحفظ التلقائي ✓");
    }, 900);
  }

  let flashTimer = null;
  function flashSaved(text) {
    const hint = $("#autoSaveHint");
    hint.textContent = text;
    hint.classList.add("show");
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => hint.classList.remove("show"), 2200);
  }

  /* =========================================================
     11) نافذة التأكيد
     ========================================================= */
  function askConfirm(title, message, action) {
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    ui.confirmAction = action;
    $("#confirmModal").classList.remove("hidden");
    window.setTimeout(() => $("#confirmOk").focus(), 60);
  }

  function closeConfirm() {
    $("#confirmModal").classList.add("hidden");
    ui.confirmAction = null;
  }

  /* =========================================================
     12) تصدير البيانات
     ========================================================= */
  function exportNotes() {
    const mine = notes.filter((n) => !n.deletedAt);
    if (!mine.length) {
      toast("لا توجد ملاحظات للتصدير", "info");
      return;
    }
    const payload = {
      app: "ملاحظاتي",
      user: currentUser ? currentUser.email : "",
      exportedAt: new Date().toISOString(),
      count: mine.length,
      notes: mine.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        color: n.color,
        pinned: n.pinned,
        favorite: n.favorite,
        createdAt: new Date(n.createdAt).toISOString(),
        updatedAt: new Date(n.updatedAt).toISOString(),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "maloohati-notes-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast("تم تصدير " + mine.length + " ملاحظة بنجاح");
  }

  /* =========================================================
     13) مؤشر قوة كلمة المرور
     ========================================================= */
  function passwordScore(value) {
    let score = 0;
    if (value.length >= 6) score++;
    if (value.length >= 10) score++;
    if (/[A-Za-z\u0600-\u06FF]/.test(value) && /\d/.test(value)) score++;
    if (/[^A-Za-z0-9\u0600-\u06FF]/.test(value)) score++;
    return score;
  }

  function updateStrength() {
    const value = $("#regPassword").value;
    const score = passwordScore(value);
    const fill = $("#strengthFill");
    const label = $("#strengthLabel");
    const levels = [
      { w: "0%", c: "var(--border)", t: "—" },
      { w: "26%", c: "var(--danger)", t: "ضعيفة" },
      { w: "52%", c: "var(--warning)", t: "متوسطة" },
      { w: "76%", c: "#0ea5e9", t: "جيدة" },
      { w: "100%", c: "var(--success)", t: "ممتازة" },
    ];
    const level = value ? levels[Math.max(1, score)] : levels[0];
    fill.style.width = level.w;
    fill.style.background = level.c;
    label.textContent = level.t;
  }

  function resetStrength() {
    $("#strengthFill").style.width = "0%";
    $("#strengthLabel").textContent = "—";
  }

  /* =========================================================
     14) ربط الأحداث
     ========================================================= */
  function wireEvents() {
    // تبويبات الدخول
    $("#tabLogin").addEventListener("click", () => switchAuthTab("login"));
    $("#tabRegister").addEventListener("click", () => switchAuthTab("register"));
    document.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => switchAuthTab(btn.dataset.goto));
    });

    // النماذج
    $("#loginForm").addEventListener("submit", handleLogin);
    $("#registerForm").addEventListener("submit", handleRegister);
    $("#resetForm").addEventListener("submit", handleReset);
    $("#newPassForm").addEventListener("submit", handleNewPassword);
    $("#regPassword").addEventListener("input", updateStrength);

    // استعادة كلمة المرور
    $("#forgotBtn").addEventListener("click", () => {
      showAuthView("reset");
      const prefill = $("#loginEmail").value.trim();
      if (prefill) $("#resetEmail").value = prefill;
      window.setTimeout(() => $("#resetEmail").focus(), 60);
    });

    // إظهار/إخفاء كلمة المرور
    document.querySelectorAll(".toggle-pass").forEach((btn) => {
      btn.addEventListener("click", () => {
        const input = document.getElementById(btn.dataset.target);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.classList.toggle("showing", show);
        btn.setAttribute("aria-label", show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
      });
    });

    // الوضع الليلي
    $("#themeToggle").addEventListener("click", toggleTheme);

    // البحث
    $("#searchInput").addEventListener("input", (e) => {
      ui.query = e.target.value;
      $("#clearSearch").classList.toggle("hidden", !ui.query);
      render();
    });
    $("#clearSearch").addEventListener("click", clearSearch);

    // الترشيح
    $("#filterChips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (chip) setFilter(chip.dataset.filter);
    });

    // زر ملاحظة جديدة
    $("#newNoteBtn").addEventListener("click", openNewNote);

    // قوائم المستخدم
    $("#userMenuBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = $("#userMenu");
      const hidden = menu.classList.toggle("hidden");
      $("#userMenuBtn").setAttribute("aria-expanded", String(!hidden));
    });
    document.addEventListener("click", (e) => {
      const menu = $("#userMenu");
      if (!menu.classList.contains("hidden") && !e.target.closest(".user-menu-wrap")) {
        menu.classList.add("hidden");
        $("#userMenuBtn").setAttribute("aria-expanded", "false");
      }
    });
    $("#exportBtn").addEventListener("click", exportNotes);
    $("#logoutBtn").addEventListener("click", handleLogout);

    // شبكة الملاحظات (نقر موحّد)
    $("#notesGrid").addEventListener("click", (e) => {
      const card = e.target.closest(".note");
      if (!card) return;
      const id = card.dataset.id;
      const actionBtn = e.target.closest(".note-action");
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.action;
        if (action === "pin") toggleFlag(id, "pinned");
        else if (action === "favorite") toggleFlag(id, "favorite");
        else if (action === "delete") softDeleteNote(id);
        else if (action === "restore") restoreNote(id);
        else if (action === "purge") {
          askConfirm("حذف نهائي", "سيتم حذف الملاحظة نهائيًا ولا يمكن استعادتها. هل أنت متأكد؟", () => purgeNote(id));
        }
        return;
      }
      openExistingNote(id);
    });

    $("#notesGrid").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".note");
      if (card && !e.target.closest(".note-action")) {
        e.preventDefault();
        openExistingNote(card.dataset.id);
      }
    });

    // المحرر
    $("#saveNoteBtn").addEventListener("click", async () => {
      const saved = await commitEditor();
      if (saved) {
        closeModal();
        toast("تم حفظ الملاحظة بنجاح");
      }
    });
    $("#cancelEditor").addEventListener("click", () => closeEditor(false));
    $("#closeEditor").addEventListener("click", () => closeEditor(false));
    $("#deleteFromEditor").addEventListener("click", () => {
      const id = ui.editingId;
      if (!id) return;
      askConfirm("حذف الملاحظة", "سيتم نقل الملاحظة إلى سلة المحذوفات، ويمكنك استعادتها لاحقًا.", () => {
        closeModal();
        softDeleteNote(id);
      });
    });
    $("#noteTitleInput").addEventListener("input", scheduleAutoSave);
    $("#noteBodyInput").addEventListener("input", scheduleAutoSave);
    $("#colorRow").addEventListener("click", (e) => {
      const swatch = e.target.closest(".swatch");
      if (!swatch) return;
      ui.editingColor = swatch.dataset.color;
      setActiveSwatch(ui.editingColor);
      scheduleAutoSave();
    });

    // إغلاق المحرر عند الضغط على الخلفية
    $("#noteModal").addEventListener("mousedown", (e) => {
      if (e.target === $("#noteModal")) closeEditor(false);
    });

    // نافذة التأكيد
    $("#confirmCancel").addEventListener("click", closeConfirm);
    $("#confirmOk").addEventListener("click", () => {
      const action = ui.confirmAction;
      closeConfirm();
      if (typeof action === "function") {
        Promise.resolve(action()).catch((err) => toast(serverErrorMessage(err), "error"));
      }
    });
    $("#confirmModal").addEventListener("mousedown", (e) => {
      if (e.target === $("#confirmModal")) closeConfirm();
    });

    // اختصارات لوحة المفاتيح
    document.addEventListener("keydown", (e) => {
      const editorOpen = !$("#noteModal").classList.contains("hidden");
      const confirmOpen = !$("#confirmModal").classList.contains("hidden");
      const appOpen = !$("#appView").classList.contains("hidden");

      if (e.key === "Escape") {
        if (confirmOpen) closeConfirm();
        else if (editorOpen) closeEditor(false);
        else if (appOpen) {
          const menu = $("#userMenu");
          if (!menu.classList.contains("hidden")) menu.classList.add("hidden");
        }
        return;
      }

      if (editorOpen && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commitEditor().then((saved) => {
          if (saved) {
            closeModal();
            toast("تم حفظ الملاحظة بنجاح");
          }
        });
        return;
      }

      if (appOpen && !editorOpen && !confirmOpen && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#searchInput").focus();
      }

      if (appOpen && !editorOpen && !confirmOpen && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNewNote();
      }
    });

    // تحديث الأوقات النسبية كل دقيقة
    window.setInterval(() => {
      if (currentUser && !document.hidden && $("#noteModal").classList.contains("hidden")) render();
    }, 60000);

    // إعادة المحاولة عند عودة الاتصال
    window.addEventListener("online", () => {
      if (currentUser) loadNotes();
    });
  }

  /* =========================================================
     15) الإقلاع
     ========================================================= */
  async function init() {
    initTheme();
    wireEvents();

    if (configStatus !== "ok" || !db) {
      $("#configBanner").classList.remove("hidden");
      showAuth();
      toast(configStatus === "sdk-missing" ? M.sdkMissing : M.notConfigured, "error");
      return;
    }

    const recoveryInUrl = /type=recovery/i.test(window.location.hash) || /type=recovery/i.test(window.location.search);

    try {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      if (data && data.session && data.session.user) {
        // جلسة وصلت من رابط الاستعادة: عرّض تعيين كلمة المرور الجديدة قبل الدخول
        if (recoveryInUrl) { showAuth(); showAuthView("newpass"); }
        else await enterApp(data.session.user);
      } else {
        showAuth();
      }
    } catch (err) {
      showAuth();
      toast(serverErrorMessage(err), "error");
    }

    // مصدر الحقيقة لحالة الجلسة (تسجيل دخول/خروج من تبويب آخر، تجديد التوكن)
    db.auth.onAuthStateChange((event, session) => {
      window.setTimeout(() => {
        if (event === "SIGNED_OUT") {
          if (currentUser) {
            currentUser = null;
            notes = [];
            showAuth();
          }
          return;
        }
        if (event === "PASSWORD_RECOVERY") {
          showAuth();
          showAuthView("newpass");
          return;
        }
        if (session && session.user && (!currentUser || currentUser.id !== session.user.id)) {
          if (/type=recovery/i.test(window.location.hash)) { showAuth(); showAuthView("newpass"); return; }
          enterApp(session.user);
        }
      }, 0);
    });
  }

  init();
})();
