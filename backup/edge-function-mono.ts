// ============================================================
// ACCOUNTING — Monobank → Supabase (Edge Function "mono")
//
// Заменяет цепочку Cloudflare Gateway → Consumer → Apps Script.
// Подключение карты делается из приложения (Ещё → Monobank).
//
// ИЗ ПРИЛОЖЕНИЯ (нужен вход в приложение, JWT пользователя):
//   POST { action: "accounts", token }              список карт по токену
//   POST { action: "connect", token, account }      привязка карты + вебхук + опрос + загрузка 31 дня
//   POST { action: "status" }                       состояние подключения (и проверка вебхука в банке)
//   POST { action: "webhook" }                      заново включить мгновенные операции (вебхук)
//   POST { action: "sync" }                         обновить сейчас (последние 48 часов + баланс)
//   POST { action: "disconnect" }                   отключить
//
// ДЛЯ БАНКА И РАСПИСАНИЯ (секрет в адресе, генерируется автоматически).
// <имя> — как функция называется в адресе Supabase (…/functions/v1/<имя>), любое:
//   POST /functions/v1/<имя>?secret=...              вебхук Monobank (и обёртка Cloudflare Consumer)
//   GET  /functions/v1/<имя>                         проверка доступности (банк шлёт её при регистрации)
//   GET  /functions/v1/<имя>?action=poll&secret=     лёгкий опрос банка (по расписанию)
//   GET  /functions/v1/<имя>?action=balance&secret=  баланс и кредитный лимит из банка
//   GET  /functions/v1/<имя>?action=status&secret=   диагностика без секретов
//
// Никаких секретов вручную задавать не нужно: токен Monobank и секрет вебхука
// хранятся в таблице mono_settings, закрытой от всех, кроме этой функции.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL: string = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY: string =
  Deno.env.get("MONO_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Необязательно: прежний способ через секреты функции продолжает работать
const ENV_TOKEN: string = Deno.env.get("MONO_TOKEN") ?? "";
const ENV_SECRET: string = Deno.env.get("MONO_WEBHOOK_SECRET") ?? "";

const MONO_API = "https://api.monobank.ua/personal";
const MAX_STATEMENT_SECONDS = 31 * 24 * 3600; // ограничение Monobank на одно окно выписки
const CORS: any = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

const db: any = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ------------------------------------------------------------
// Вспомогательные функции
// ------------------------------------------------------------
function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function coded(code: string, message: string, status: number): any {
  const e: any = new Error(message);
  e.code = code;
  e.httpStatus = status;
  return e;
}

function failFrom(e: any): Response {
  if (e && e.code && e.httpStatus) {
    return json({ ok: false, error: e.code, message: String(e.message) }, e.httpStatus);
  }
  console.error("[MONO]", e && e.message ? e.message : e);
  return json({ ok: false, error: "INTERNAL_ERROR", message: String(e && e.message ? e.message : e) }, 500);
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b: number) => b.toString(16).padStart(2, "0")).join("");
}

// «Silpo (FX 840 12.34)» → «Silpo»  (как в старом stripMonobankFxSuffix_)
function stripFx(value: any): string {
  return String(value ?? "").replace(/\s*\(FX[^)]*\)\s*$/i, "").trim();
}

// Ключ заметки для правил (как normalizeRuleKey_): без хвоста FX, нижний регистр, пробелы схлопнуты
function noteKey(value: any): string {
  return stripFx(value).toLowerCase().replace(/\s+/g, " ");
}

function currencyFromCode(code: any): string {
  const n = Number(code);
  if (n === 980) return "UAH";
  if (n === 840) return "USD";
  if (n === 978) return "EUR";
  return "ISO-" + String(code);
}

function isSupportedCurrency(code: any): boolean {
  return ["UAH", "USD", "EUR"].indexOf(currencyFromCode(code)) >= 0;
}

// ------------------------------------------------------------
// Правила: тот же порядок поиска, что был в Rules.gs
// ------------------------------------------------------------
function buildRulesMap(rules: any): any {
  const map = new Map();
  (rules || []).forEach((rule: any) => {
    const key = String(rule.action) + "::" + noteKey(rule.note);
    if (!map.has(key)) map.set(key, rule); // при дубле остаётся первое
  });
  return map;
}

function resolveRule(rulesMap: any, bankAction: string, note: string): any {
  const key = noteKey(note);
  if (!key) return null;
  const candidates =
    bankAction === "EXPENSE" ? ["EXPENSE", "TRANSFER"] : ["INCOME", "RETURN", "TRANSFER"];
  for (const action of candidates) {
    const rule = rulesMap.get(action + "::" + key);
    if (rule) return rule;
  }
  return null;
}

// ------------------------------------------------------------
// StatementItem → строка таблицы transactions
// ------------------------------------------------------------
function buildTransactionRow(item: any, binding: any, ctx: any): any {
  const monoOpId = String(item?.id ?? "").trim();
  if (!monoOpId) throw new Error("statementItem.id is missing");

  const raw = Number(item.amount);
  if (!isFinite(raw)) throw new Error("statementItem.amount is invalid");
  if (raw === 0) return { skip: "ZERO_AMOUNT", monoOpId: monoOpId };

  const date = new Date(Number(item.time) * 1000);
  if (isNaN(date.getTime())) throw new Error("statementItem.time is invalid");

  const bankAction = raw < 0 ? "EXPENSE" : "INCOME";
  const note = stripFx(String(item.description ?? "").trim());
  const rule = resolveRule(ctx.rulesMap, bankAction, note);

  let action = bankAction;
  let categoryId: any = null;
  let accountId: any = binding.id;
  let fromId: any = null;
  let toId: any = null;

  if (rule && rule.action === "TRANSFER") {
    action = "TRANSFER";
    fromId = rule.from_account_id;
    toId = rule.to_account_id;
    accountId = null;
  } else if (rule) {
    action = rule.action;
    categoryId = rule.category_id;
  } else if (bankAction === "EXPENSE") {
    categoryId = ctx.uncategorizedExpenseId; // нет правила: «Uncategorized»
  }

  return {
    monoOpId: monoOpId,
    matched: Boolean(rule),
    row: {
      date: date.toISOString(),
      action: action,
      amount: Math.abs(raw) / 100,
      category_id: categoryId,
      account_id: accountId,
      from_account_id: fromId,
      to_account_id: toId,
      currency: binding.currency,
      note: note,
      mono_op_id: monoOpId,
    },
  };
}

// ------------------------------------------------------------
// База данных
// ------------------------------------------------------------
async function loadContext(): Promise<any> {
  const rulesRes = await db
    .from("rules")
    .select("id,action,category_id,from_account_id,to_account_id,note")
    .order("id");
  if (rulesRes.error) throw rulesRes.error;

  const catRes = await db.from("categories").select("id,name,type");
  if (catRes.error) throw catRes.error;

  const uncategorized = (catRes.data || []).filter(
    (c: any) => c.type === "EXPENSE" && /^Uncategorized/i.test(String(c.name)),
  )[0];

  return {
    rulesMap: buildRulesMap(rulesRes.data),
    uncategorizedExpenseId: uncategorized ? uncategorized.id : null,
    rulesCount: (rulesRes.data || []).length,
  };
}

async function getSettings(): Promise<any> {
  const res = await db
    .from("mono_settings")
    .select("token,webhook_secret,client_name,card_mask,connected_at")
    .eq("id", 1)
    .limit(1);
  if (res.error) throw res.error;
  return (res.data || [])[0] || null;
}

async function resolveToken(): Promise<string> {
  const s = await getSettings();
  const token = (s && s.token) || ENV_TOKEN;
  if (!token) {
    throw coded("NOT_CONNECTED", "Monobank ещё не подключён: открой Ещё → Monobank и вставь токен.", 400);
  }
  return token;
}

async function secretMatches(secret: any): Promise<boolean> {
  if (typeof secret !== "string" || !secret) return false;
  const s = await getSettings();
  if (s && s.webhook_secret && safeEqual(secret, s.webhook_secret)) return true;
  return Boolean(ENV_SECRET) && safeEqual(secret, ENV_SECRET);
}

async function getBindingByMonoId(monoAccountId: string): Promise<any> {
  const res = await db
    .from("accounts")
    .select("id,name,currency,mono_account_id")
    .eq("mono_account_id", monoAccountId)
    .limit(1);
  if (res.error) throw res.error;
  return (res.data || [])[0] || null;
}

async function getAnyBinding(): Promise<any> {
  const res = await db
    .from("accounts")
    .select("id,name,currency,mono_account_id")
    .eq("is_monobank", true)
    .limit(1);
  if (res.error) throw res.error;
  const row = (res.data || [])[0] || null;
  return row && row.mono_account_id ? row : null;
}

// Одна операция (вебхук). Идемпотентность: mono_op_id уникален, повтор игнорируется
async function ingestItem(item: any, binding: any, ctx: any): Promise<any> {
  const built = buildTransactionRow(item, binding, ctx);
  if (built.skip) return { skipped: true, reason: built.skip };

  const res = await db
    .from("transactions")
    .upsert(built.row, { onConflict: "mono_op_id", ignoreDuplicates: true })
    .select("id");
  if (res.error) throw res.error;

  const created = (res.data || []).length > 0;
  return { created: created, duplicate: !created, action: built.row.action, ruleMatched: built.matched };
}

// Много операций (выписка): пачками по 200
async function ingestMany(items: any[], binding: any, ctx: any): Promise<any> {
  const out = { received: items.length, created: 0, duplicates: 0, skipped: 0, errors: 0, firstError: "" };
  const rows: any[] = [];
  for (const item of items) {
    try {
      const built = buildTransactionRow(item, binding, ctx);
      if (built.skip) out.skipped++;
      else rows.push(built.row);
    } catch (e: any) {
      out.errors++;
      if (!out.firstError) out.firstError = String(e && e.message ? e.message : e);
    }
  }
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await db
      .from("transactions")
      .upsert(chunk, { onConflict: "mono_op_id", ignoreDuplicates: true })
      .select("id");
    if (res.error) throw res.error;
    const n = (res.data || []).length;
    out.created += n;
    out.duplicates += chunk.length - n;
  }
  return out;
}

async function saveBalance(balanceKop: any, creditLimitKop: any, source: string): Promise<void> {
  const row: any = { id: 1, balance_kop: Math.round(Number(balanceKop)), updated_at: new Date().toISOString(), source: source };
  if (creditLimitKop !== null && creditLimitKop !== undefined) {
    row.credit_limit_kop = Math.round(Number(creditLimitKop));
  }
  const res = await db.from("mono_state").upsert(row, { onConflict: "id" });
  if (res.error) throw res.error;
}

// ------------------------------------------------------------
// Monobank API
// ------------------------------------------------------------
async function monoFetch(path: string, token: string, init: any): Promise<any> {
  const res = await fetch(MONO_API + path, init);
  const text = await res.text();
  if (res.status === 429) {
    const e = coded("RATE_LIMITED", "Monobank просит подождать минуту (лимит запросов). Попробуй ещё раз через минуту.", 429);
    e.rateLimited = true;
    throw e;
  }
  if (res.status === 403) {
    throw coded("INVALID_TOKEN", "Monobank не принял токен. Получи новый на api.monobank.ua и вставь заново.", 400);
  }
  if (res.status !== 200) {
    throw coded("MONOBANK_ERROR", "Monobank API: HTTP " + res.status + " " + text.slice(0, 200), 502);
  }
  return text ? JSON.parse(text) : {};
}

async function monoGet(path: string, token: string): Promise<any> {
  return await monoFetch(path, token, { headers: { "X-Token": token } });
}

async function monoPost(path: string, body: any, token: string): Promise<any> {
  return await monoFetch(path, token, {
    method: "POST",
    headers: { "X-Token": token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Адрес самой функции. Supabase выдаёт имя сам (например smart-api), поэтому берём его из запроса,
// а не из кода: так вебхук и расписание всегда указывают туда, куда нужно.
function functionBaseUrl(req: Request): string {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const slug = parts.length ? parts[parts.length - 1] : "mono";
  return SUPABASE_URL + "/functions/v1/" + slug;
}

function webhookUrl(req: Request, secret: string): string {
  return functionBaseUrl(req) + "?secret=" + encodeURIComponent(secret);
}

async function registerWebhook(req: Request, token: string, secret: string): Promise<void> {
  try {
    await monoPost("/webhook", { webHookUrl: webhookUrl(req, secret) }, token);
  } catch (e: any) {
    if (e && e.rateLimited) throw e;
    throw coded(
      "WEBHOOK_FAILED",
      "Не удалось зарегистрировать вебхук в банке. Проверь, что у функции в Supabase выключена проверка JWT (Settings → Verify JWT). Ответ банка: " +
        String(e && e.message ? e.message : e),
      502,
    );
  }
}

// ------------------------------------------------------------
// Выписка → база (общая часть для сверки, опроса и первичной загрузки)
// ------------------------------------------------------------
async function runStatement(binding: any, token: string, seconds: number): Promise<any> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - Math.min(Math.floor(seconds), MAX_STATEMENT_SECONDS);
  const items = await monoGet("/statement/" + encodeURIComponent(binding.mono_account_id) + "/" + from + "/" + to, token);
  if (!Array.isArray(items)) throw coded("MONOBANK_ERROR", "Monobank statement: неожиданный ответ", 502);
  const ctx = await loadContext();
  const ordered = items.slice().sort((a: any, b: any) => Number(a.time) - Number(b.time));
  const out = await ingestMany(ordered, binding, ctx);
  return { ...out, newest: ordered.length ? ordered[ordered.length - 1] : null };
}

async function refreshBalance(binding: any, token: string): Promise<any> {
  const info = await monoGet("/client-info", token);
  const acc = (info.accounts || []).filter((a: any) => a.id === binding.mono_account_id)[0];
  if (!acc) return null;
  await saveBalance(acc.balance, acc.creditLimit || 0, "client-info");
  return { balance: Number(acc.balance || 0) / 100, creditLimit: Number(acc.creditLimit || 0) / 100 };
}

// ------------------------------------------------------------
// Вебхук банка
// ------------------------------------------------------------
async function handleWebhook(body: any, url: URL): Promise<Response> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ ok: false, error: "INVALID_BODY" }, 400);
  }

  const secret = url.searchParams.get("secret") ?? (typeof body.secret === "string" ? body.secret : "");
  if (!(await secretMatches(secret))) {
    const s = await getSettings();
    if (!(s && s.webhook_secret) && !ENV_SECRET) return json({ ok: false, error: "SERVICE_NOT_CONFIGURED" }, 500);
    return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  }

  // Обёртка Cloudflare Consumer: { secret, message: { payload } }; иначе — «чистый» вебхук банка
  const payload = body.message && body.message.payload ? body.message.payload : body;

  if (!payload || payload.type !== "StatementItem" || !payload.data) {
    return json({ ok: true, skipped: true, reason: "UNSUPPORTED_PAYLOAD" });
  }

  const monoAccountId = String(payload.data.account ?? "").trim();
  const item = payload.data.statementItem;
  if (!monoAccountId || !item) return json({ ok: false, error: "STATEMENT_ITEM_REQUIRED" }, 400);

  try {
    const binding = await getBindingByMonoId(monoAccountId);
    if (!binding) {
      // 200, чтобы банк не повторял запрос
      return json({ ok: true, skipped: true, reason: "UNBOUND_ACCOUNT" });
    }

    const ctx = await loadContext();
    const result = await ingestItem(item, binding, ctx);

    if (typeof item.balance === "number") {
      await saveBalance(item.balance, null, "webhook");
    }
    return json({ ok: true, ...result });
  } catch (e: any) {
    console.error("[MONO][WEBHOOK]", e && e.message ? e.message : e);
    // 500: банк (или очередь Cloudflare) повторит запрос, дубли исключены уникальным mono_op_id
    return json({ ok: false, error: "INTERNAL_ERROR", message: String(e && e.message ? e.message : e) }, 500);
  }
}

// ------------------------------------------------------------
// Действия по секрету в адресе (расписание и диагностика)
// ------------------------------------------------------------
async function handleSecretAction(action: string, url: URL): Promise<Response> {
  if (!(await secretMatches(url.searchParams.get("secret")))) {
    return json({ ok: false, error: "UNAUTHORIZED" }, 401);
  }
  if (action === "poll") return await actionPoll(url);
  if (action === "balance") return await actionBalance();
  if (action === "status") return json(await buildStatus());
  return json({ ok: false, error: "UNKNOWN_ACTION" }, 400);
}

// Лёгкий опрос по расписанию: один запрос выписки; в базу пишет только то, чего ещё нет
async function actionPoll(url: URL): Promise<Response> {
  const binding = await getAnyBinding();
  if (!binding) return json({ ok: false, error: "NOT_BOUND", message: "Карта ещё не привязана." }, 400);
  const token = await resolveToken();

  let hours = Number(url.searchParams.get("hours") ?? 3);
  if (!isFinite(hours) || hours <= 0) hours = 3;
  const seconds = Math.min(Math.floor(hours * 3600), MAX_STATEMENT_SECONDS);

  const to = Math.floor(Date.now() / 1000);
  const from = to - seconds;

  let items: any;
  try {
    items = await monoGet("/statement/" + encodeURIComponent(binding.mono_account_id) + "/" + from + "/" + to, token);
  } catch (e: any) {
    // Лимит банка (1 запрос в минуту): для расписания это не ошибка, просто пропускаем круг
    if (e && e.rateLimited) return json({ ok: true, rateLimited: true });
    throw e;
  }
  if (!Array.isArray(items)) throw coded("MONOBANK_ERROR", "Monobank statement: неожиданный ответ", 502);

  const ordered = items
    .filter((i: any) => i && Number(i.amount) !== 0)
    .sort((a: any, b: any) => Number(a.time) - Number(b.time));
  if (!ordered.length) return json({ ok: true, received: items.length, missing: 0, created: 0 });

  // Сначала один лёгкий запрос: какие операции уже есть
  const ids = ordered.map((i: any) => String(i.id));
  const exist = await db.from("transactions").select("mono_op_id").in("mono_op_id", ids);
  if (exist.error) throw exist.error;
  const have = new Set((exist.data || []).map((r: any) => String(r.mono_op_id)));
  const missing = ordered.filter((i: any) => !have.has(String(i.id)));
  if (!missing.length) return json({ ok: true, received: items.length, missing: 0, created: 0 });

  const ctx = await loadContext();
  const out = await ingestMany(missing, binding, ctx);

  // Нашлись пропущенные вебхуком операции: баланс берём из самой новой
  if (out.created > 0) {
    const newest = ordered[ordered.length - 1];
    if (typeof newest.balance === "number") await saveBalance(newest.balance, null, "poll");
  }
  return json({ ok: out.errors === 0, missing: missing.length, ...out });
}

async function actionBalance(): Promise<Response> {
  const binding = await getAnyBinding();
  if (!binding) return json({ ok: false, error: "NOT_BOUND" }, 400);
  const token = await resolveToken();
  try {
    const r = await refreshBalance(binding, token);
    if (!r) return json({ ok: false, error: "ACCOUNT_NOT_FOUND_IN_BANK" }, 404);
    return json({ ok: true, ...r });
  } catch (e: any) {
    if (e && e.rateLimited) return json({ ok: true, rateLimited: true });
    throw e;
  }
}

async function buildStatus(req?: Request): Promise<any> {
  const settings = await getSettings();
  const binding = await getAnyBinding();
  const hasToken = Boolean((settings && settings.token) || ENV_TOKEN);
  const st = await db.from("mono_state").select("balance_kop,credit_limit_kop,updated_at,source").eq("id", 1).limit(1);

  let polling: any = null;
  try {
    const r = await db.rpc("mono_polling_status");
    if (!r.error) polling = Boolean(r.data);
  } catch (_e) { /* расписание недоступно */ }

  // Проверяем, что банк действительно шлёт операции к нам (банк отключает вебхук после нескольких неудач)
  let webhook: any = "unknown";
  if (req && hasToken && binding) {
    try {
      const token = (settings && settings.token) || ENV_TOKEN;
      const info = await monoGet("/client-info", token);
      const current = String(info.webHookUrl || "");
      const secret = settings && settings.webhook_secret ? settings.webhook_secret : "";
      if (!current) webhook = "missing";
      else if (current.indexOf(functionBaseUrl(req)) === 0 && (!secret || current.indexOf(encodeURIComponent(secret)) >= 0)) webhook = "active";
      else webhook = "other";
    } catch (_e) { /* лимит запросов или нет связи: не знаем */ }
  }

  const ctx = await loadContext();
  return {
    ok: true,
    webhook: webhook,
    connected: Boolean(binding && hasToken),
    account: binding ? { name: binding.name, currency: binding.currency } : null,
    card: settings && settings.card_mask ? settings.card_mask : null,
    clientName: settings && settings.client_name ? settings.client_name : null,
    connectedAt: settings && settings.connected_at ? settings.connected_at : null,
    state: (st.data || [])[0] || null,
    polling: polling,
    rules: ctx.rulesCount,
    uncategorizedCategory: ctx.uncategorizedExpenseId !== null,
  };
}

// ------------------------------------------------------------
// Действия из приложения (нужен вход: JWT пользователя)
// ------------------------------------------------------------
async function handleAppAction(req: Request, body: any): Promise<Response> {
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) return json({ ok: false, error: "UNAUTHORIZED", message: "Войди в приложение заново." }, 401);
  const who = await db.auth.getUser(jwt);
  if (who.error || !who.data || !who.data.user) {
    return json({ ok: false, error: "UNAUTHORIZED", message: "Войди в приложение заново." }, 401);
  }

  const action = String(body.action || "").toLowerCase();
  if (action === "accounts") return await appAccounts(body);
  if (action === "connect") return await appConnect(req, body);
  if (action === "status") return json(await buildStatus(req));
  if (action === "webhook") return await appWebhook(req);
  if (action === "sync") return await appSync();
  if (action === "disconnect") return await appDisconnect();
  return json({ ok: false, error: "UNKNOWN_ACTION", message: "Неизвестное действие." }, 400);
}

function cleanToken(value: any): string {
  const token = String(value ?? "").trim();
  if (token.length < 20 || /\s/.test(token)) {
    throw coded("INVALID_TOKEN", "Это не похоже на токен Monobank. Скопируй его целиком с api.monobank.ua.", 400);
  }
  return token;
}

// Шаг 1: по токену показываем карты, ничего не сохраняя
async function appAccounts(body: any): Promise<Response> {
  const token = cleanToken(body.token);
  const info = await monoGet("/client-info", token);
  const accounts: any[] = Array.isArray(info.accounts) ? info.accounts : [];
  const supported = accounts.filter((a: any) => isSupportedCurrency(a.currencyCode));
  if (!supported.length) {
    return json({ ok: false, error: "NO_ACCOUNTS", message: "В этом аккаунте Monobank нет счетов в UAH, USD или EUR." }, 400);
  }
  return json({
    ok: true,
    clientName: info.name || "",
    accounts: supported.map((a: any) => ({
      id: a.id,
      type: a.type,
      currencyCode: a.currencyCode,
      currency: currencyFromCode(a.currencyCode),
      maskedPan: a.maskedPan || [],
      balance: Number(a.balance || 0),
      creditLimit: Number(a.creditLimit || 0),
    })),
  });
}

// Шаг 2: привязка выбранной карты и всё остальное
async function appConnect(req: Request, body: any): Promise<Response> {
  const token = cleanToken(body.token);
  const acc = body.account;
  if (!acc || typeof acc.id !== "string" || !acc.id || !isSupportedCurrency(acc.currencyCode)) {
    throw coded("ACCOUNT_REQUIRED", "Выбери карту из списка.", 400);
  }
  const currency = currencyFromCode(acc.currencyCode);
  const card = Array.isArray(acc.maskedPan) && acc.maskedPan.length ? String(acc.maskedPan[0]) : "";

  // 1. Счёт «Monobank 💳» в приложении
  const appRes = await db.from("accounts").select("id,name").eq("is_monobank", true).limit(1);
  if (appRes.error) throw appRes.error;
  const appAccount = (appRes.data || [])[0];
  if (!appAccount) {
    throw coded("NO_APP_ACCOUNT", "В приложении нет счёта Monobank. Создай счёт «Monobank 💳» (Счета → ＋ Счёт).", 500);
  }

  // 2. Токен и новый секрет вебхука (хранятся только в закрытой таблице)
  const secret = randomSecret();
  const saved = await db.from("mono_settings").upsert(
    {
      id: 1,
      token: token,
      webhook_secret: secret,
      client_name: String(body.clientName || ""),
      card_mask: card,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (saved.error) throw saved.error;

  // 3. Привязка карты к счёту
  const upd = await db
    .from("accounts")
    .update({ mono_account_id: acc.id, currency: currency })
    .eq("id", appAccount.id)
    .select("id");
  if (upd.error) throw upd.error;

  // 4. Баланс из банка (значения пришли с шага 1, лишний запрос не нужен)
  await saveBalance(acc.balance, acc.creditLimit || 0, "client-info");

  // 5. Вебхук: после этого банк присылает операции сюда
  await registerWebhook(req, token, secret);

  // 6. Расписание опроса (не критично: вебхук работает и без него)
  let polling = false;
  let pollingNote = "";
  try {
    const r = await db.rpc("mono_enable_polling", { function_url: functionBaseUrl(req) });
    if (r.error) throw r.error;
    polling = true;
  } catch (e: any) {
    pollingNote = String(e && e.message ? e.message : e);
  }

  // 7. Первичная загрузка за 31 день, сразу по правилам
  const binding = { id: appAccount.id, currency: currency, mono_account_id: acc.id };
  let imported: any = null;
  let importNote = "";
  try {
    const r = await runStatement(binding, token, MAX_STATEMENT_SECONDS);
    imported = { received: r.received, created: r.created, duplicates: r.duplicates, skipped: r.skipped, errors: r.errors };
  } catch (e: any) {
    importNote = String(e && e.message ? e.message : e);
  }

  return json({
    ok: true,
    account: { name: appAccount.name, currency: currency, card: card },
    balance: Number(acc.balance || 0) / 100,
    creditLimit: Number(acc.creditLimit || 0) / 100,
    webhook: "registered",
    polling: polling,
    pollingNote: pollingNote,
    imported: imported,
    importNote: importNote,
  });
}

// «Включить мгновенные операции»: заново зарегистрировать вебхук (токен берём из базы)
async function appWebhook(req: Request): Promise<Response> {
  const settings = await getSettings();
  const binding = await getAnyBinding();
  const token = (settings && settings.token) || ENV_TOKEN;
  if (!binding || !token) throw coded("NOT_CONNECTED", "Monobank ещё не подключён.", 400);

  let secret = settings && settings.webhook_secret ? settings.webhook_secret : "";
  if (!secret) {
    secret = randomSecret();
    const saved = await db.from("mono_settings").upsert({ id: 1, token: token, webhook_secret: secret }, { onConflict: "id" });
    if (saved.error) throw saved.error;
  }
  await registerWebhook(req, token, secret);
  return json({ ok: true, webhook: "active" });
}

// «Обновить сейчас»: последние 48 часов + баланс
async function appSync(): Promise<Response> {
  const binding = await getAnyBinding();
  if (!binding) throw coded("NOT_CONNECTED", "Monobank ещё не подключён.", 400);
  const token = await resolveToken();

  const r = await runStatement(binding, token, 48 * 3600);
  let balance: any = null;
  try {
    balance = await refreshBalance(binding, token); // другой метод API, свой лимит запросов
  } catch (_e) { /* не критично */ }

  return json({
    ok: r.errors === 0,
    received: r.received, created: r.created, duplicates: r.duplicates, skipped: r.skipped, errors: r.errors,
    firstError: r.firstError,
    balance: balance,
  });
}

async function appDisconnect(): Promise<Response> {
  const settings = await getSettings();
  const token = (settings && settings.token) || ENV_TOKEN;

  let webhookRemoved = false;
  if (token) {
    try {
      await monoPost("/webhook", { webHookUrl: "" }, token);
      webhookRemoved = true;
    } catch (_e) { /* банк мог не ответить: вебхук всё равно перестанет работать без секрета */ }
  }

  try { await db.rpc("mono_disable_polling"); } catch (_e) { /* расписания могло и не быть */ }

  const unbind = await db.from("accounts").update({ mono_account_id: null }).eq("is_monobank", true).select("id");
  if (unbind.error) throw unbind.error;
  const del = await db.from("mono_settings").delete().eq("id", 1);
  if (del.error) throw del.error;

  return json({ ok: true, webhookRemoved: webhookRemoved });
}

// ------------------------------------------------------------
// Точка входа
// ------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    const url = new URL(req.url);
    const queryAction = (url.searchParams.get("action") || "").toLowerCase();

    if (req.method === "GET") {
      if (!queryAction) return new Response("ok", { status: 200, headers: CORS }); // проверка доступности от Monobank
      return await handleSecretAction(queryAction, url);
    }
    if (req.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

    let body: any = null;
    try {
      body = await req.json();
    } catch (_e) {
      return json({ ok: false, error: "INVALID_JSON" }, 400);
    }

    if (queryAction) return await handleSecretAction(queryAction, url);
    if (body && typeof body.action === "string") return await handleAppAction(req, body);
    return await handleWebhook(body, url);
  } catch (e: any) {
    return failFrom(e);
  }
});
