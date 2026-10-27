// Sistema de chamados - Etapa 1 (MVP interno, armazenamento local de DEMONSTRAÇÃO). Sem dependências.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, FILE = path.join(__dirname, 'data', 'demo.json'), PUB = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname, WL = ['index.html', 'abrir-chamado.html', 'style.css', 'manifest.json', 'sw.js'];
// Autenticação provisória (demonstração). Etapa 4 troca por login Google com lista de e-mails.
const TOKENS = { [process.env.ADMIN_TOKEN || 'demo-admin']: { nome: 'Admin (demo)', perfil: 'root' }, [process.env.ATENDENTE_TOKEN || 'demo-atendente']: { nome: 'Atendente (demo)', perfil: 'atendente' } };
const DEFAULT = {
  tickets: [], history: [], outbox: [], users: [], clients: [], config: {
    publicOpen: false, contactChannel: 'Fale com a equipe pelo canal oficial.',
    recurrence: { threshold: 3, windowDays: 30, similarity: 0.6 }, resolvedStatuses: ['resolvido', 'concluído', 'concluido', 'fechado', 'encerrado'], _demo: true
  }
};
// ---- Camada de armazenamento (trocável: JsonRepo -> SheetsRepo -> banco) ----
class JsonRepo {
  constructor() { try { this.db = JSON.parse(fs.readFileSync(FILE)) } catch { this.db = structuredClone(DEFAULT) } }
  save() { fs.writeFileSync(FILE + '.tmp', JSON.stringify(this.db, null, 1)); fs.renameSync(FILE + '.tmp', FILE) }
}
const repo = new JsonRepo(), db = repo.db; db.users = db.users || []; db.clients = db.clients || [];
db.statuses = db.statuses || [['Aberto', 'aberto'], ['Em andamento', 'aberto'], ['Aguardando', 'aberto'], ['Resolvido', 'resolvido']].map(([nome, tipo], i) => ({ id: 'ST-' + (i + 1), nome, tipo, ativo: true, demo: true }));
const stRes = n => { n = String(n || '').toLowerCase(); const x = db.statuses.find(y => y.nome.toLowerCase() == n); return x ? x.tipo == 'resolvido' : db.config.resolvedStatuses.includes(n) };
const PERMS = [['chamados.ver', 'Ver chamados', 'Chamados'], ['chamados.criar', 'Criar chamados', 'Chamados'], ['chamados.editar', 'Editar dados do chamado', 'Chamados'], ['chamados.atribuir', 'Atribuir e transferir', 'Chamados'], ['chamados.status', 'Alterar status, encerrar e reabrir', 'Chamados'], ['chamados.comentar', 'Comentar', 'Chamados'], ['chamados.atender', 'Registrar tempo de atendimento', 'Chamados'], ['chamados.excluir', 'Excluir chamados', 'Chamados'], ['painel.ver', 'Ver painel', 'Painel'], ['importar.usar', 'Importar planilha', 'Dados'], ['dados.exportar', 'Exportar e backup dos dados', 'Dados'], ['clientes.gerenciar', 'Cadastrar e editar clientes', 'Cadastros'], ['status.gerenciar', 'Gerenciar status', 'Cadastros'], ['funcionarios.gerenciar', 'Gerenciar funcionários', 'Administração'], ['perfis.gerenciar', 'Gerenciar perfis e permissões', 'Administração'], ['config.gerenciar', 'Configurações (switch público, recorrência)', 'Administração']].map(([k, rotulo, grupo]) => ({ k, rotulo, grupo })), ALL = PERMS.map(x => x.k);
const EDIT = ['title', 'description', 'client', 'contactName', 'whatsapp', 'email', 'owner', 'team', 'priority', 'category', 'sentToDev', 'solution', 'notes', 'revisedDescription'], PM = { owner: 'chamados.atribuir', team: 'chamados.atribuir' };
db.profiles = db.profiles || [{ id: 'root', nome: 'Root', perms: ALL, sistema: true, travado: true }, { id: 'admin', nome: 'Administrador', perms: ALL.filter(k => k != 'perfis.gerenciar'), sistema: true }, { id: 'atendente', nome: 'Atendente', perms: ['chamados.ver', 'chamados.criar', 'chamados.editar', 'chamados.atribuir', 'chamados.status', 'chamados.comentar', 'chamados.atender', 'painel.ver', 'clientes.gerenciar'], sistema: true }, { id: 'cliente', nome: 'Cliente', perms: ['chamados.ver'], sistema: true, somenteProprioCliente: true }];
db.profiles.find(x => x.id == 'root').perms = ALL;['admin', 'atendente'].forEach(i => { const x = db.profiles.find(y => y.id == i); if (x && !x.perms.includes('chamados.atender')) x.perms.push('chamados.atender') }); db.config.sla = db.config.sla || { Urgente: 4, Alta: 8, Normal: 24, Baixa: 72 }; db.config.devStaleDays = db.config.devStaleDays || 3; db.trash = db.trash || []; db.users.forEach(u => { if (!u.perfil) u.perfil = u.role == 'admin' ? 'admin' : 'atendente'; delete u.role });
// ---- Métricas do painel ----
const slaH = t => { const k = Object.keys(db.config.sla).find(x => x.toLowerCase() == String(t.priority || '').toLowerCase()); return k ? db.config.sla[k] : null };
const durMs = (l, now) => (l || []).reduce((s, x) => s + (new Date(x.end || now) - new Date(x.start)), 0);
function dashExtra(T) {
  const now = Date.now(), H = 36e5, ab = T.filter(t => !isResolved(t)), sla = { abertosNoPrazo: 0, estourados: 0, resolvidosNoPrazo: 0, resolvidosFora: 0, semSla: 0 }, pior = [];
  T.forEach(t => { const h = slaH(t); if (h == null) { sla.semSla++; return } const due = new Date(t.openedAt).getTime() + h * H; if (isResolved(t)) { if (!t.resolvedAt) { sla.semSla++; return } new Date(t.resolvedAt).getTime() <= due ? sla.resolvidosNoPrazo++ : sla.resolvidosFora++ } else if (now > due) { sla.estourados++; pior.push({ id: t.id, title: t.title, horas: Math.round((now - due) / H) }) } else sla.abertosNoPrazo++ });
  const par = {}, f = x => par[x] == null || par[x] == x ? (par[x] = x) : (par[x] = f(par[x])), ids = new Set(T.map(t => t.id)); T.forEach(t => (t.relatedIds || []).forEach(r => { if (ids.has(r)) par[f(t.id)] = f(r) }));
  const gr = {}; T.forEach(t => { if ((t.relatedIds || []).length || T.some(o => (o.relatedIds || []).includes(t.id))) (gr[f(t.id)] = gr[f(t.id)] || []).push(t) });
  const rec = Object.values(gr).filter(x => x.length > 1).map(x => { x.sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt)); return { titulo: x[0].title, total: x.length, abertos: x.filter(t => !isResolved(t)).length } }).sort((a, b) => b.total - a.total).slice(0, 8);
  const sentAt = t => { const hs = db.history.filter(h => h.id == t.id && /^sentToDev:.*→ true$/.test(h.what)); return hs.length ? hs[hs.length - 1].at : t.openedAt };
  const dev = ab.filter(t => t.sentToDev).map(t => ({ id: t.id, title: t.title, dias: Math.floor((now - new Date(sentAt(t))) / 864e5) })), lim = db.config.devStaleDays;
  const faixas = [['0 a 1 dia', 0, 1], ['2 a 3 dias', 2, 3], ['4 a 7 dias', 4, 7], ['8 dias ou mais', 8, 1e9]].map(([l, a, b]) => ({ faixa: l, total: dev.filter(x => x.dias >= a && x.dias <= b).length }));
  const por = {}; ab.forEach(t => { const n = t.owner || 'Sem responsável'; por[n] = por[n] || { nome: n, retidos: 0, dev: 0 }; t.sentToDev ? por[n].dev++ : por[n].retidos++ }); const ret = ab.filter(t => !t.sentToDev).length;
  const cT = T.filter(t => (t.timeLog || []).some(x => x.end));
  return {
    sla: { ...sla, pior: pior.sort((a, b) => b.horas - a.horas).slice(0, 5) }, recorrencia: rec, devParados: { total: dev.length, parados: dev.filter(x => x.dias >= lim).length, limiteDias: lim, faixas, maisAntigos: dev.sort((a, b) => b.dias - a.dias).slice(0, 5) },
    retencao: { retidos: ret, abertos: ab.length, pct: ab.length ? Math.round(ret / ab.length * 1000) / 10 : null, porResponsavel: Object.values(por).sort((x, y) => (y.retidos + y.dev) - (x.retidos + x.dev)).slice(0, 10) },
    tempo: { chamados: cT.length, mediaMin: cT.length ? Math.round(cT.reduce((s, t) => s + durMs((t.timeLog || []).filter(x => x.end), now), 0) / cT.length / 6e4) : null }
  }
}
const actor = (base, perfil, extra = {}) => { const pf = db.profiles.find(x => x.id == perfil) || { perms: [] }; return { ...base, perfil, perms: pf.perms, scoped: !!pf.somenteProprioCliente, ...extra } };
const defStatus = () => (db.statuses.find(x => x.ativo && x.tipo == 'aberto') || { nome: 'Aberto' }).nome;
const ensureStatus = n => { if (n && !db.statuses.some(x => x.nome.toLowerCase() == n.toLowerCase())) db.statuses.push({ id: 'ST-' + (db.statuses.length + 1), nome: n, tipo: stRes(n) ? 'resolvido' : 'aberto', ativo: true, origem: 'importação' }) };
// ---- Login Google (verifica o ID token no servidor; GOOGLE_CLIENT_ID vem de variável de ambiente) ----
const GID = process.env.GOOGLE_CLIENT_ID || '', CERTS = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs', sessions = {}; let certs = { at: 0, keys: [] };
async function googleVerify(cred) {
  const [h, pl, sg] = String(cred).split('.'); if (!sg) throw 0; const head = JSON.parse(Buffer.from(h, 'base64url')), pay = JSON.parse(Buffer.from(pl, 'base64url'));
  if (Date.now() - certs.at > 36e5) certs = { at: Date.now(), keys: (await (await fetch(CERTS)).json()).keys };
  const k = certs.keys.find(x => x.kid == head.kid); if (!k || head.alg != 'RS256') throw 0;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + pl), crypto.createPublicKey({ key: k, format: 'jwk' }), Buffer.from(sg, 'base64url'));
  if (!ok || pay.aud !== GID || !['accounts.google.com', 'https://accounts.google.com'].includes(pay.iss) || pay.exp * 1000 < Date.now() || !pay.email_verified) throw 0; return pay
}
const ensureClient = n => { if (n && !db.clients.some(c => c.nome.toLowerCase() == n.toLowerCase())) db.clients.push({ id: 'CL-' + String(db.clients.length + 1).padStart(4, '0'), nome: n, email: '', whatsapp: '', contato: '', ativo: true, origem: 'importação' }) };
// ---- Recorrência ----
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
const sim = (a, b) => { const A = new Set(norm(a)), B = new Set(norm(b)); if (!A.size || !B.size) return 0; let i = 0; A.forEach(x => B.has(x) && i++); return i / (A.size + B.size - i) };
function checkRecurrence(t) {
  const c = db.config.recurrence, lim = Date.now() - c.windowDays * 864e5;
  const rel = db.tickets.filter(o => o.id !== t.id && new Date(o.openedAt) >= lim && Math.max(sim(o.title, t.title), sim(o.title + ' ' + o.description, t.title + ' ' + t.description)) >= c.similarity);
  if (rel.length + 1 >= c.threshold) {
    const n = rel.length + 1, why = `Recorrente: ${n} ocorrências semelhantes em ${c.windowDays} dias`;
    [t, ...rel].forEach(x => { if (!x.recurrent || x.urgentReason !== why) { x.recurrent = true; x.priority = 'Urgente'; x.urgentReason = why; hist(x.id, 'sistema', 'Marcado como urgente por recorrência', why) } });
  }
  t.relatedIds = rel.map(x => x.id)
}
const hist = (id, who, what, reason = '') => db.history.push({ id, at: new Date().toISOString(), who, what, reason });
const isResolved = t => stRes(t.status);
// ---- CSV ----
function parseCSV(s) {
  const rows = []; let r = [], f = '', q = false; s = s.replace(/^\uFEFF/, ''); const d = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : (s.split('\n')[0].includes('\t') ? '\t' : ',');
  for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c == '"') { if (s[i + 1] == '"') { f += '"'; i++ } else q = false } else f += c } else if (c == '"') q = true; else if (c == d) { r.push(f); f = '' } else if (c == '\n') { r.push(f.replace(/\r$/, '')); rows.push(r); r = []; f = '' } else f += c }
  if (f || r.length) { r.push(f); rows.push(r) } return rows.filter(r => r.some(x => x.trim()))
}
const FIELDS = { externalId: ['sup', 'chamado os', 'os', 'id'], status: ['status'], owner: ['proprietario', 'responsavel'], openedAt: ['data', 'abertura'], notes: ['observacoes', 'obs'], recurrent: ['recorrente'], client: ['cliente'], title: ['titulo'], description: ['descricao'] };
const slug = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
const suggest = h => { const used = new Set(), m = h.map(x => { const s = slug(x); for (const [f, al] of Object.entries(FIELDS)) if (!used.has(f) && al.some(a => s === a || s.startsWith(a))) { used.add(f); return f } return '' }); return m };
function parseDate(v) {
  v = (v || '').trim(); let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { const y = m[3].length == 2 ? '20' + m[3] : m[3]; return new Date(Date.UTC(y, m[2] - 1, m[1])).toISOString() }
  const d = new Date(v); return isNaN(d) ? null : d.toISOString()
}
function mapRow(row, map) { const o = {}; map.forEach((f, i) => { if (f) o[f] = (row[i] || '').trim() }); return o }
function analyze(rows, map) {
  const seen = new Set(), res = []; rows.forEach((r, i) => {
    const o = mapRow(r, map), p = [];
    if (!o.externalId) p.push('ID/OS vazio'); if (!o.title && !o.description && !o.notes) p.push('sem título/descrição/observações');
    if (o.openedAt && !parseDate(o.openedAt)) p.push('data inválida');
    const key = o.externalId; if (key && (seen.has(key) || db.tickets.some(t => t.externalId === key))) p.push('duplicado'); if (key) seen.add(key);
    res.push({ linha: i + 2, dados: o, problemas: p })
  }); return res
}
// ---- HTTP ----
const buckets = {}; const limited = ip => { const n = Date.now(), b = (buckets[ip] || []).filter(t => n - t < 6e5); b.push(n); buckets[ip] = b; return b.length > 5 };
const send = (res, c, o) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)) };
const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) { no(); req.destroy() } }); req.on('end', () => { try { ok(JSON.parse(b || '{}')) } catch { no() } }) });
const cleanML = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n), clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const nextId = () => { db.seq = [...db.tickets, ...db.trash].reduce((m, t) => Math.max(m, +t.id.slice(3) || 0), db.seq || 0) + 1; return 'CH-' + String(db.seq).padStart(5, '0') };
function newTicket(d, src, by) {
  const t = { id: nextId(), externalId: d.externalId || '', title: d.title, description: d.description || '', revisedDescription: '', client: d.client || '', contactName: d.contactName || '', email: d.email || '', whatsapp: d.whatsapp || '', owner: d.owner || '', team: d.team || '', status: d.status || defStatus(), priority: d.priority || 'Normal', category: d.category || '', channel: src, openedAt: d.openedAt || new Date().toISOString(), sentToDev: !!d.sentToDev, resolvedAt: null, solution: '', notes: d.notes || '', recurrent: false, urgentReason: '', relatedIds: [], comments: [] };
  db.tickets.push(t); hist(t.id, by, 'Chamado criado (' + src + ')'); checkRecurrence(t); return t
}
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname, ip = req.socket.remoteAddress;
    if (p == '/api/config/public') return send(res, 200, { publicOpen: db.config.publicOpen, contactChannel: db.config.contactChannel, googleClientId: GID });
    if (p == '/api/public/tickets' && req.method == 'POST') {
      const d = await body(req);
      if (!db.config.publicOpen) return send(res, 403, { erro: 'Abertura pública indisponível.', canal: db.config.contactChannel });
      if (d.website) return send(res, 200, { protocolo: 'OK' }); if (limited(ip)) return send(res, 429, { erro: 'Muitas tentativas. Tente mais tarde.' });
      const e = {}; const v = { title: clean(d.title, 120), description: clean(d.description, 4000), contactName: clean(d.contactName, 100), email: clean(d.email, 120), whatsapp: clean(d.whatsapp, 20).replace(/[^\d+]/g, ''), category: clean(d.category, 60) };
      if (v.title.length < 5) e.title = 'Informe um título com ao menos 5 caracteres.'; if (v.description.length < 10) e.description = 'Descreva o problema com ao menos 10 caracteres.'; if (!v.contactName) e.contactName = 'Informe seu nome.';
      if (!v.email && !v.whatsapp) e.contato = 'Informe e-mail ou WhatsApp para receber o retorno.'; if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) e.email = 'E-mail inválido.'; if (v.whatsapp && v.whatsapp.replace(/\D/g, '').length < 10) e.whatsapp = 'WhatsApp inválido (inclua DDD).';
      if (Object.keys(e).length) return send(res, 400, { erros: e });
      const t = newTicket({ ...v, client: v.contactName }, 'Público', 'solicitante'); repo.save(); return send(res, 201, { protocolo: t.id })
    }
    if (p == '/api/auth/google' && req.method == 'POST') {
      const d = await body(req); if (!GID) return send(res, 503, { erro: 'Login Google não configurado no servidor (GOOGLE_CLIENT_ID).' });
      let pay; try { pay = await googleVerify(d.credential) } catch { return send(res, 401, { erro: 'Não foi possível validar a conta Google.' }) }
      const email = pay.email.toLowerCase(); let us = db.users.find(x => x.email == email);
      if (d.mode == 'signup') {
        if (us) return send(res, 409, { erro: us.status == 'ativo' ? 'Você já tem cadastro. Use "Já tenho cadastro".' : 'Seu cadastro já foi enviado e aguarda aprovação do administrador.' });
        db.users.push({ email, nome: clean(pay.name || email, 100), perfil: 'cliente', cliente: '', status: 'pendente' }); hist('usuarios', 'sistema', 'Autocadastro Google pendente: ' + email); repo.save(); return send(res, 202, { mensagem: 'Cadastro enviado. Um administrador precisa aprovar seu acesso.' })
      }
      if (!us) return send(res, 403, { erro: 'Este e-mail não está cadastrado. Escolha "Quero me cadastrar".' }); if (us.status != 'ativo') return send(res, 403, { erro: us.status == 'pendente' ? 'Seu cadastro aguarda aprovação do administrador.' : 'Seu acesso está desativado.' });
      const tok = crypto.randomBytes(24).toString('hex'); sessions[tok] = { email, exp: Date.now() + 432e5 }; return send(res, 200, { token: tok })
    }
    if (p.startsWith('/api/')) {
      const ss = sessions[req.headers['x-token']], su = ss && ss.exp > Date.now() && db.users.find(x => x.email == ss.email && x.status == 'ativo'), tk = TOKENS[req.headers['x-token']], a = tk ? actor({ nome: tk.nome }, tk.perfil) : (su && actor({ nome: su.nome, email: su.email }, su.perfil, { cliente: su.cliente || '' })); if (!a) return send(res, 401, { erro: 'Não autorizado.' });
      if (p == '/api/me') return send(res, 200, a);
      const need = k => { if (a.perms.includes(k)) return false; send(res, 403, { erro: 'Sem permissão para esta ação.' }); return true };
      const visible = t => !a.scoped || (!!a.cliente && (t.client || '').toLowerCase() == a.cliente.toLowerCase()), viewT = t => a.scoped ? { ...t, notes: '', urgentReason: '', relatedIds: [], comments: t.comments.filter(c => c.visibleToRequester), timeLog: [] } : t, canGrant = pf => !!pf && pf.perms.every(k => a.perms.includes(k));
      if (p == '/api/users' && req.method == 'GET') { if (u.searchParams.get('all')) { if (need('funcionarios.gerenciar')) return; return send(res, 200, db.users) } if (a.scoped) return send(res, 200, []); return send(res, 200, db.users.filter(x => x.status == 'ativo').map(x => ({ email: x.email, nome: x.nome }))) }
      if (p == '/api/users' && req.method == 'POST') {
        if (need('funcionarios.gerenciar')) return; const d = await body(req), email = clean(d.email, 120).toLowerCase(), nome = clean(d.nome, 100), pf = db.profiles.find(x => x.id == d.perfil);
        if (!nome || !/^\S+@\S+\.\S+$/.test(email)) return send(res, 400, { erro: 'Informe nome e um e-mail válido.' }); if (!pf) return send(res, 400, { erro: 'Escolha o perfil.' }); if (!canGrant(pf)) return send(res, 403, { erro: 'Você não pode conceder um perfil com permissões que você não tem.' });
        if (db.users.some(x => x.email == email)) return send(res, 409, { erro: 'Este e-mail já está cadastrado.' });
        db.users.push({ email, nome, perfil: pf.id, cliente: clean(d.cliente, 120), status: 'ativo' }); hist('usuarios', a.nome, 'Funcionário cadastrado: ' + email + ' (' + pf.nome + ')'); repo.save(); return send(res, 201, { ok: 1 })
      }
      const mu = p.match(/^\/api\/users\/(.+)$/);
      if (mu && req.method == 'PATCH') {
        if (need('funcionarios.gerenciar')) return; const x = db.users.find(y => y.email == decodeURIComponent(mu[1])); if (!x) return send(res, 404, { erro: 'Usuário não encontrado.' }); const d = await body(req);
        if (!canGrant(db.profiles.find(y => y.id == x.perfil))) return send(res, 403, { erro: 'Você não pode alterar um usuário com mais permissões que as suas.' });
        if (x.email == a.email && ((d.perfil && d.perfil != x.perfil) || (d.status && d.status != 'ativo'))) return send(res, 400, { erro: 'Você não pode alterar o próprio perfil nem se desativar.' });
        if (d.perfil) { const pf = db.profiles.find(y => y.id == d.perfil); if (!pf) return send(res, 400, { erro: 'Perfil inválido.' }); if (!canGrant(pf)) return send(res, 403, { erro: 'Você não pode conceder um perfil com permissões que você não tem.' }); x.perfil = pf.id }
        if (['ativo', 'pendente', 'inativo'].includes(d.status)) x.status = d.status; if (d.nome) x.nome = clean(d.nome, 100); if (d.cliente != null) x.cliente = clean(d.cliente, 120); hist('usuarios', a.nome, 'Usuário alterado: ' + x.email + ' (' + x.perfil + ', ' + x.status + ')'); repo.save(); return send(res, 200, x)
      }
      if (p == '/api/profiles' && req.method == 'GET') { if (!a.perms.includes('perfis.gerenciar') && need('funcionarios.gerenciar')) return; return send(res, 200, { perfis: db.profiles.map(x => ({ ...x, usuarios: db.users.filter(y => y.perfil == x.id).length })), catalogo: PERMS }) }
      const pfb = d => ({ nome: clean(d.nome, 60), perms: [...new Set((Array.isArray(d.perms) ? d.perms : []).filter(k => ALL.includes(k)))], somenteProprioCliente: !!d.somenteProprioCliente });
      if (p == '/api/profiles' && req.method == 'POST') {
        if (need('perfis.gerenciar')) return; const b = pfb(await body(req)); if (!b.nome) return send(res, 400, { erro: 'Informe o nome do perfil.' }); if (db.profiles.some(x => x.nome.toLowerCase() == b.nome.toLowerCase())) return send(res, 409, { erro: 'Já existe um perfil com esse nome.' });
        if (b.perms.some(k => !a.perms.includes(k))) return send(res, 403, { erro: 'Você não pode conceder permissões que você não tem.' }); const x = { id: 'pf-' + Date.now().toString(36), ...b }; db.profiles.push(x); hist('perfis', a.nome, 'Perfil criado: ' + b.nome); repo.save(); return send(res, 201, x)
      }
      const mp = p.match(/^\/api\/profiles\/([\w-]+)$/);
      if (mp && req.method == 'PATCH') {
        if (need('perfis.gerenciar')) return; const x = db.profiles.find(y => y.id == mp[1]); if (!x) return send(res, 404, { erro: 'Perfil não encontrado.' }); if (x.travado) return send(res, 400, { erro: 'O perfil Root não pode ser alterado.' }); const b = pfb(await body(req));
        if (!b.nome) return send(res, 400, { erro: 'Informe o nome do perfil.' }); if (db.profiles.some(y => y.id != x.id && y.nome.toLowerCase() == b.nome.toLowerCase())) return send(res, 409, { erro: 'Já existe um perfil com esse nome.' });
        if (b.perms.some(k => !a.perms.includes(k) && !x.perms.includes(k))) return send(res, 403, { erro: 'Você não pode conceder permissões que você não tem.' }); Object.assign(x, b); hist('perfis', a.nome, 'Perfil alterado: ' + b.nome); repo.save(); return send(res, 200, x)
      }
      if (mp && req.method == 'DELETE') {
        if (need('perfis.gerenciar')) return; const x = db.profiles.find(y => y.id == mp[1]); if (!x) return send(res, 404, { erro: 'Perfil não encontrado.' }); if (x.sistema) return send(res, 400, { erro: 'Perfis padrão não podem ser excluídos.' }); if (db.users.some(y => y.perfil == x.id)) return send(res, 409, { erro: 'Há funcionários com este perfil. Troque o perfil deles antes.' });
        db.profiles.splice(db.profiles.indexOf(x), 1); hist('perfis', a.nome, 'Perfil excluído: ' + x.nome); repo.save(); return send(res, 200, { ok: 1 })
      }
      if (p == '/api/statuses' && req.method == 'GET') return send(res, 200, u.searchParams.get('all') ? db.statuses : db.statuses.filter(x => x.ativo !== false));
      if (p == '/api/statuses' && req.method == 'POST') {
        if (need('status.gerenciar')) return; const d = await body(req), nome = clean(d.nome, 60); if (!nome) return send(res, 400, { erro: 'Informe o nome do status.' }); if (!['aberto', 'resolvido'].includes(d.tipo)) return send(res, 400, { erro: 'Escolha o tipo do status.' });
        if (db.statuses.some(x => x.nome.toLowerCase() == nome.toLowerCase())) return send(res, 409, { erro: 'Já existe um status com esse nome.' });
        const x = { id: 'ST-' + (db.statuses.length + 1), nome, tipo: d.tipo, ativo: true }; db.statuses.push(x); hist('status', a.nome, 'Status cadastrado: ' + nome + ' (' + d.tipo + ')'); repo.save(); return send(res, 201, x)
      }
      const ms = p.match(/^\/api\/statuses\/([\w-]+)$/);
      if (ms && req.method == 'PATCH') {
        if (need('status.gerenciar')) return; const x = db.statuses.find(y => y.id == ms[1]); if (!x) return send(res, 404, { erro: 'Status não encontrado.' }); const d = await body(req), nn = d.nome != null ? clean(d.nome, 60) : x.nome, nt = d.tipo || x.tipo, na = 'ativo' in d ? !!d.ativo : x.ativo !== false;
        if (!nn) return send(res, 400, { erro: 'Informe o nome do status.' }); if (!['aberto', 'resolvido'].includes(nt)) return send(res, 400, { erro: 'Tipo inválido.' }); if (db.statuses.some(y => y.id != x.id && y.nome.toLowerCase() == nn.toLowerCase())) return send(res, 409, { erro: 'Já existe um status com esse nome.' });
        if (x.tipo == 'aberto' && x.ativo !== false && (nt != 'aberto' || !na) && db.statuses.filter(y => y.tipo == 'aberto' && y.ativo !== false).length == 1) return send(res, 400, { erro: 'Mantenha ao menos um status ativo do tipo em aberto.' });
        if (nn != x.nome) db.tickets.forEach(t => { if (t.status == x.nome) t.status = nn }); x.nome = nn; x.tipo = nt; x.ativo = na; hist('status', a.nome, 'Status alterado: ' + nn + ' (' + nt + ', ' + (na ? 'ativo' : 'inativo') + ')'); repo.save(); return send(res, 200, x)
      }
      if (p == '/api/clients' && req.method == 'GET') return send(res, 200, a.scoped ? [] : u.searchParams.get('all') ? db.clients : db.clients.filter(c => c.ativo !== false));
      if (p == '/api/clients' && req.method == 'POST') {
        if (need('clientes.gerenciar')) return; const d = await body(req), nome = clean(d.nome, 120); if (!nome) return send(res, 400, { erro: 'Informe o nome do cliente.' }); if (db.clients.some(c => c.nome.toLowerCase() == nome.toLowerCase())) return send(res, 409, { erro: 'Já existe um cliente com esse nome.' });
        const c = { id: 'CL-' + String(db.clients.length + 1).padStart(4, '0'), nome, email: clean(d.email, 120), whatsapp: clean(d.whatsapp, 20).replace(/[^\d+]/g, ''), contato: clean(d.contato, 100), ativo: true }; db.clients.push(c); hist('clientes', a.nome, 'Cliente cadastrado: ' + nome); repo.save(); return send(res, 201, c)
      }
      const mc = p.match(/^\/api\/clients\/([\w-]+)$/);
      if (mc && req.method == 'PATCH') {
        if (need('clientes.gerenciar')) return; const c = db.clients.find(x => x.id == mc[1]); if (!c) return send(res, 404, { erro: 'Cliente não encontrado.' }); const d = await body(req);
        if (d.nome != null) { const n = clean(d.nome, 120); if (!n) return send(res, 400, { erro: 'Informe o nome do cliente.' }); if (db.clients.some(x => x.id != c.id && x.nome.toLowerCase() == n.toLowerCase())) return send(res, 409, { erro: 'Já existe um cliente com esse nome.' }); db.tickets.forEach(t => { if (t.client == c.nome) t.client = n }); c.nome = n }
        for (const k of ['email', 'contato']) if (d[k] != null) c[k] = clean(d[k], 120); if (d.whatsapp != null) c.whatsapp = clean(d.whatsapp, 20).replace(/[^\d+]/g, ''); if ('ativo' in d) c.ativo = !!d.ativo; repo.save(); return send(res, 200, c)
      }
      if (p == '/api/tickets' && req.method == 'GET') {
        if (need('chamados.ver')) return; const q = u.searchParams; let l = db.tickets.filter(t => visible(t) && (!q.get('status') || t.status == q.get('status')) && (!q.get('owner') || t.owner == q.get('owner')) && (!q.get('client') || t.client.toLowerCase().includes(q.get('client').toLowerCase())) && (!q.get('recurrent') || t.recurrent) && (!q.get('q') || slug(t.title + ' ' + t.description + ' ' + t.externalId + ' ' + t.id).includes(slug(q.get('q')))));
        return send(res, 200, l.sort((x, y) => (y.priority == 'Urgente') - (x.priority == 'Urgente') || new Date(y.openedAt) - new Date(x.openedAt)).map(viewT))
      }
      if (p == '/api/tickets' && req.method == 'POST') {
        if (need('chamados.criar')) return; const d = await body(req); if (clean(d.title, 120).length < 3) return send(res, 400, { erro: 'Título obrigatório.' }); if (d.status && !db.statuses.some(x => x.ativo && x.nome == d.status)) return send(res, 400, { erro: 'Status não cadastrado ou inativo.' });
        const t = newTicket({ ...d, title: clean(d.title, 120), description: clean(d.description, 4000) }, d.channel || 'Interno', a.nome); repo.save(); return send(res, 201, t)
      }
      let m = p.match(/^\/api\/tickets\/([\w-]+)$/);
      const mt = p.match(/^\/api\/tickets\/([\w-]+)\/timer$/);
      if (mt && req.method == 'POST') {
        if (need('chamados.atender')) return; const t = db.tickets.find(x => x.id == mt[1]); if (!t || !visible(t)) return send(res, 404, { erro: 'Não encontrado.' }); const d = await body(req); t.timeLog = t.timeLog || [];
        if (d.action == 'start') {
          const mine = db.tickets.find(x => (x.timeLog || []).some(l => !l.end && l.who == a.nome)); if (mine) return send(res, 409, { erro: 'Você já tem um atendimento em andamento no chamado ' + mine.id + '. Finalize-o antes de iniciar outro.' });
          t.timeLog.push({ who: a.nome, start: new Date().toISOString(), end: null }); hist(t.id, a.nome, 'Atendimento iniciado'); repo.save(); return send(res, 200, viewT(t))
        }
        if (d.action == 'stop') {
          const l = t.timeLog.find(x => !x.end && (x.who == a.nome || a.perms.includes('chamados.editar'))); if (!l) return send(res, 400, { erro: 'Não há atendimento seu em andamento neste chamado.' }); l.end = new Date().toISOString();
          hist(t.id, a.nome, 'Atendimento finalizado (' + Math.round((new Date(l.end) - new Date(l.start)) / 6e4) + ' min)' + (l.who != a.nome ? ' — sessão de ' + l.who : '')); repo.save(); return send(res, 200, viewT(t))
        }
        return send(res, 400, { erro: 'Ação inválida.' })
      }
      if (m && req.method == 'DELETE') {
        if (need('chamados.excluir')) return; const i = db.tickets.findIndex(x => x.id == m[1]), t = db.tickets[i]; if (!t || !visible(t)) return send(res, 404, { erro: 'Não encontrado.' }); const d = await body(req); if (!clean(d.reason, 300)) return send(res, 400, { erro: 'Informe o motivo da exclusão.' });
        db.trash.push({ ...t, deletedAt: new Date().toISOString(), deletedBy: a.nome, deleteReason: clean(d.reason, 300) }); db.tickets.splice(i, 1); db.tickets.forEach(x => { x.relatedIds = (x.relatedIds || []).filter(r => r != t.id) }); hist(t.id, a.nome, 'Chamado excluído', clean(d.reason, 300)); repo.save(); return send(res, 200, { ok: 1 })
      }
      if (m && req.method == 'PATCH') {
        const t = db.tickets.find(x => x.id == m[1]); if (!t || !visible(t)) return send(res, 404, { erro: 'Não encontrado.' }); const d = await body(req);
        const nv = (k, x) => k == 'sentToDev' ? !!x : cleanML(x, k == 'title' ? 120 : 4000), miss = []; if (d.status && d.status != t.status) miss.push('chamados.status'); for (const k of EDIT) if (k in d && nv(k, d[k]) !== t[k]) miss.push(PM[k] || 'chamados.editar'); if (d.comment) miss.push('chamados.comentar');
        const bad = miss.find(k => !a.perms.includes(k)); if (bad) return send(res, 403, { erro: 'Sem permissão: ' + PERMS.find(x => x.k == bad).rotulo + '.' }); if ('title' in d && nv('title', d.title).length < 3) return send(res, 400, { erro: 'Título obrigatório.' });
        if (d.status && d.status != t.status) {
          if (!db.statuses.some(x => x.ativo && x.nome == d.status)) return send(res, 400, { erro: 'Status não cadastrado ou inativo.' }); const reopen = isResolved(t) && !stRes(d.status), close = !isResolved(t) && stRes(d.status);
          if ((reopen || close) && !clean(d.reason, 300)) return send(res, 400, { erro: 'Informe o motivo para encerrar ou reabrir.' });
          hist(t.id, a.nome, `Status: ${t.status} → ${d.status}`, clean(d.reason, 300)); t.resolvedAt = close ? new Date().toISOString() : (reopen ? null : t.resolvedAt); t.status = d.status
        }
        for (const k of EDIT) if (k in d) { const v = k == 'sentToDev' ? !!d[k] : cleanML(d[k], k == 'title' ? 120 : 4000); if (v !== t[k]) { hist(t.id, a.nome, `${k}: ${String(t[k] || '—').slice(0, 80)} → ${String(v || '—').slice(0, 80)}`, clean(d.reason, 300)); t[k] = v } }
        if (d.comment) t.comments.push({ at: new Date().toISOString(), who: a.nome, text: clean(d.comment, 2000), visibleToRequester: !!d.visibleToRequester });
        if (d.comment && d.visibleToRequester && t.whatsapp) db.outbox.push({ at: new Date().toISOString(), to: t.whatsapp, ticket: t.id, msg: clean(d.comment, 500), sent: false, nota: 'Fila de demonstração: nada é enviado.' });
        repo.save(); return send(res, 200, t)
      }
      if (p == '/api/dashboard') { if (need('painel.ver')) return; const T = db.tickets, res_ = T.filter(isResolved), sem = res_.filter(t => !t.sentToDev); return send(res, 200, { ...dashExtra(T), abertos: T.length - res_.length, resolvidos: res_.length, devs: T.filter(t => t.sentToDev).length, recorrentesAbertos: T.filter(t => t.recurrent && !isResolved(t)).length, taxaSemDev: { num: sem.length, den: res_.length, pct: res_.length ? Math.round(sem.length / res_.length * 1000) / 10 : null } }) }
      if (p == '/api/import/preview' && req.method == 'POST') {
        if (need('importar.usar')) return; const d = await body(req), rows = parseCSV(d.csv || ''); if (rows.length < 2) return send(res, 400, { erro: 'CSV vazio.' }); const h = rows[0], map = d.map || suggest(h), an = analyze(rows.slice(1), map);
        return send(res, 200, { colunas: h, mapa: map, campos: Object.keys(FIELDS), semDestino: h.filter((_, i) => !map[i]), total: an.length, problemas: an.filter(x => x.problemas.length).length, amostra: an.slice(0, 200) })
      }
      if (p == '/api/import/commit' && req.method == 'POST') {
        if (need('importar.usar')) return; const d = await body(req), rows = parseCSV(d.csv || '').slice(1), an = analyze(rows, d.map), rel = { importados: [], ignorados: [] };
        an.forEach(x => {
          if (x.problemas.length) return rel.ignorados.push({ linha: x.linha, id: x.dados.externalId, motivo: x.problemas.join('; ') }); const o = x.dados;
          const t = newTicket({ externalId: o.externalId, title: o.title || (o.notes || o.description).slice(0, 80), description: o.description || '', client: o.client, owner: o.owner, status: o.status || defStatus(), openedAt: o.openedAt ? parseDate(o.openedAt) : null, notes: [o.notes, o.recurrent ? 'Recorrente (planilha): ' + o.recurrent : ''].filter(Boolean).join('\n') }, 'Importação', a.nome);
          if (isResolved(t)) t.resolvedAt = t.openedAt; ensureClient(t.client); ensureStatus(t.status); rel.importados.push(t.id)
        }); repo.save(); return send(res, 200, rel)
      }
      if (p == '/api/config' && req.method == 'GET') { if (need('config.gerenciar')) return; return send(res, 200, db.config) }
      if (p == '/api/config' && req.method == 'PUT') {
        if (need('config.gerenciar')) return; const d = await body(req);
        if ('publicOpen' in d) { db.config.publicOpen = !!d.publicOpen; hist('config', a.nome, 'Abertura pública ' + (d.publicOpen ? 'ATIVADA' : 'DESATIVADA')) }
        if (d.contactChannel != null) db.config.contactChannel = clean(d.contactChannel, 300); if (d.recurrence) Object.assign(db.config.recurrence, { threshold: +d.recurrence.threshold || 3, windowDays: +d.recurrence.windowDays || 30, similarity: +d.recurrence.similarity || 0.6 }); if (d.sla && typeof d.sla == 'object') for (const [k, v] of Object.entries(d.sla)) { const n = +v; if (k.length < 40 && n > 0 && n <= 8760) db.config.sla[k] = n; else if (v === '' || n === 0) delete db.config.sla[k] } if (+d.devStaleDays > 0) db.config.devStaleDays = Math.min(+d.devStaleDays, 365); repo.save(); return send(res, 200, db.config)
      }
      if (p == '/api/export') { if (need('dados.exportar')) return; return send(res, 200, db) }
      return send(res, 404, { erro: 'Rota inexistente.' })
    }
    let f = p == '/' ? '/index.html' : p == '/abrir-chamado' ? '/abrir-chamado.html' : p; f = path.join(PUB, path.normalize(f).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(PUB) || !WL.includes(path.basename(f)) || !fs.existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada. Procurei em: ' + PUB + '\nConfirme que index.html, abrir-chamado.html, style.css, manifest.json e sw.js estão nessa pasta (ou em uma pasta "public" ao lado do server.js).') }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }; res.writeHead(200, { 'content-type': (types[path.extname(f)] || 'application/octet-stream') + '; charset=utf-8' }); fs.createReadStream(f).pipe(res)
  } catch (e) { send(res, 400, { erro: 'Requisição inválida.' }) }
}).listen(PORT, () => console.log('http://localhost:' + PORT + '  (modo demonstração)'));
