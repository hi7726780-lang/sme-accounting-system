const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const csrf = require('csurf');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const rootDir = __dirname;
const dbPath = path.join(rootDir, 'data', 'accounting.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
const schemaSql = fs.readFileSync(path.join(rootDir, 'db', 'schema.sql'), 'utf8');
db.exec(schemaSql);

app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));
app.use(express.static(path.join(rootDir, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sme-accounting-system-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8, httpOnly: true }
}));
app.use(csrf({ cookie: true }));

const translations = {
  en: {
    app_name: 'SME Accounting',
    login: 'Login',
    register: 'Register Company',
    dashboard: 'Dashboard',
    company: 'Company',
    accounts: 'Chart of Accounts',
    journals: 'Journals',
    ledger: 'Ledger',
    trial_balance: 'Trial Balance',
    statements: 'Financial Statements',
    logout: 'Logout',
    period_lock: 'Period Lock',
    audit: 'Audit Log',
    company_name: 'Company Name',
    country: 'Country',
    language: 'Language',
    activity: 'Business Activity',
    currency: 'Currency',
    period_from: 'Period From',
    period_to: 'Period To',
    period_open: 'Open',
    period_locked: 'Locked'
  },
  ar: {
    app_name: 'المحاسبة الصغيرة',
    login: 'تسجيل الدخول',
    register: 'تسجيل الشركة',
    dashboard: 'لوحة التحكم',
    company: 'الشركة',
    accounts: 'دليل الحسابات',
    journals: 'قيود اليومية',
    ledger: 'دفتر الأستاذ',
    trial_balance: 'ميزان المراجعة',
    statements: 'القوائم المالية',
    logout: 'تسجيل الخروج',
    period_lock: 'قفل الفترة',
    audit: 'سجل التدقيق',
    company_name: 'اسم الشركة',
    country: 'الدولة',
    language: 'اللغة',
    activity: 'نشاط الأعمال',
    currency: 'العملة',
    period_from: 'من',
    period_to: 'إلى',
    period_open: 'مفتوح',
    period_locked: 'مغلق'
  }
};

function getCurrentUser() {
  if (!global.db) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
}

function getCompany(companyId) {
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
}

function getUserCompanyRole(userId, companyId) {
  const row = db.prepare('SELECT role FROM user_companies WHERE user_id = ? AND company_id = ?').get(userId, companyId);
  return row ? row.role : null;
}

function ensureCompanyProfile(companyId) {
  const company = getCompany(companyId);
  if (!company) return null;
  const settings = db.prepare('SELECT * FROM company_settings WHERE company_id = ?').get(companyId) || {};
  return {
    ...company,
    settings,
    isLocked: !!company.is_locked
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(roles) {
  return function (req, res, next) {
    if (!req.session.userId || !req.session.companyId) {
      return res.redirect('/login');
    }
    const role = getUserCompanyRole(req.session.userId, req.session.companyId);
    if (!role || !roles.includes(role)) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: 'You do not have permission to access this area.',
        user: currentUser(req),
        company: getCompany(req.session.companyId),
        lang: req.session.lang || 'en',
        dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
        t: translations[req.session.lang || 'en']
      });
    }
    next();
  };
}

app.use((req, res, next) => {
  const user = currentUser(req);
  res.locals.user = user;
  res.locals.company = req.session.companyId ? getCompany(req.session.companyId) : null;
  res.locals.lang = req.session.lang || 'en';
  res.locals.dir = res.locals.lang === 'ar' ? 'rtl' : 'ltr';
  res.locals.t = translations[res.locals.lang];
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  res.locals.formatMoney = (value) => {
    const amount = Number(value || 0);
    const symbol = res.locals.company && res.locals.company.currency ? res.locals.company.currency : 'EGP';
    return `${symbol} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  next();
});

app.use((req, res, next) => {
  const publicPaths = ['/login', '/register', '/logout'];
  if (publicPaths.includes(req.path)) return next();
  if (!req.session.userId) return res.redirect('/login');
  if (!req.session.companyId) {
    const membership = db.prepare('SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY id LIMIT 1').get(req.session.userId);
    if (membership) {
      req.session.companyId = membership.company_id;
    }
  }
  next();
});

function applyLanguage(req, lang) {
  req.session.lang = lang || 'en';
  if (req.session.userId) {
    db.prepare('UPDATE users SET language = ? WHERE id = ?').run(req.session.lang, req.session.userId);
  }
}

function accountBalanceById(companyId, accountId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(jl.debit),0) AS total_debit, COALESCE(SUM(jl.credit),0) AS total_credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.company_id = ? AND jl.account_id = ? AND je.status = 'posted'
  `).get(companyId, accountId);
  if (!row) return 0;
  const account = db.prepare('SELECT nature FROM chart_of_accounts WHERE id = ?').get(accountId);
  if (!account) return 0;
  return account.nature === 'debit' ? Number(row.total_debit || 0) - Number(row.total_credit || 0) : Number(row.total_credit || 0) - Number(row.total_debit || 0);
}

function accountTotalsByCompany(companyId) {
  return db.prepare(`
    SELECT a.id, a.code, a.english_name, a.arabic_name, a.account_group, a.nature,
      COALESCE(SUM(jl.debit),0) AS total_debit,
      COALESCE(SUM(jl.credit),0) AS total_credit
    FROM chart_of_accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.company_id = a.company_id AND je.status = 'posted'
    WHERE a.company_id = ?
    GROUP BY a.id, a.code, a.english_name, a.arabic_name, a.account_group, a.nature
    ORDER BY a.code ASC
  `).all(companyId);
}

function getAccountByCode(companyId, code) {
  return db.prepare('SELECT * FROM chart_of_accounts WHERE company_id = ? AND code = ?').get(companyId, code);
}

function buildFinancialStatement(companyId) {
  const accounts = accountTotalsByCompany(companyId);
  const revenueAccounts = accounts.filter(a => a.account_group === 'Revenue');
  const expenseAccounts = accounts.filter(a => a.account_group === 'Expenses');
  const assetAccounts = accounts.filter(a => a.account_group === 'Assets');
  const liabilityAccounts = accounts.filter(a => a.account_group === 'Liabilities');
  const equityAccounts = accounts.filter(a => a.account_group === 'Equity');

  const revenue = revenueAccounts.reduce((sum, a) => sum + (a.nature === 'credit' ? Number(a.total_credit || 0) - Number(a.total_debit || 0) : Number(a.total_debit || 0) - Number(a.total_credit || 0)), 0);
  const expenses = expenseAccounts.reduce((sum, a) => sum + (a.nature === 'debit' ? Number(a.total_debit || 0) - Number(a.total_credit || 0) : Number(a.total_credit || 0) - Number(a.total_debit || 0)), 0);

  const totalAssets = assetAccounts.reduce((sum, a) => sum + (a.nature === 'debit' ? Number(a.total_debit || 0) - Number(a.total_credit || 0) : Number(a.total_credit || 0) - Number(a.total_debit || 0)), 0);
  const totalLiabilities = liabilityAccounts.reduce((sum, a) => sum + (a.nature === 'credit' ? Number(a.total_credit || 0) - Number(a.total_debit || 0) : Number(a.total_debit || 0) - Number(a.total_credit || 0)), 0);
  const totalEquity = equityAccounts.reduce((sum, a) => sum + (a.nature === 'credit' ? Number(a.total_credit || 0) - Number(a.total_debit || 0) : Number(a.total_debit || 0) - Number(a.total_credit || 0)), 0);

  const netIncome = revenue - expenses;
  const totalEquityWithIncome = totalEquity + netIncome;
  const equityCheck = totalAssets - (totalLiabilities + totalEquityWithIncome);

  return {
    revenue,
    expenses,
    netIncome,
    totalAssets,
    totalLiabilities,
    totalEquity,
    totalEquityWithIncome,
    equityCheck,
    revenueAccounts,
    expenseAccounts,
    assetAccounts,
    liabilityAccounts,
    equityAccounts
  };
}

function buildDashboardMetrics(companyId) {
  const comp = getCompany(companyId);
  const statement = buildFinancialStatement(companyId);
  const cashAccount = getAccountByCode(companyId, '1000');
  const arAccount = getAccountByCode(companyId, '1010');
  const apAccount = getAccountByCode(companyId, '2000');
  const inventoryAccount = getAccountByCode(companyId, '1020');
  const cash = cashAccount ? accountBalanceById(companyId, cashAccount.id) : 0;
  const ar = arAccount ? accountBalanceById(companyId, arAccount.id) : 0;
  const ap = apAccount ? accountBalanceById(companyId, apAccount.id) : 0;
  const inventory = inventoryAccount ? accountBalanceById(companyId, inventoryAccount.id) : 0;

  const revenue = statement.revenue;
  const netProfit = statement.netIncome;
  const grossMargin = revenue ? ((revenue - statement.expenses) / revenue) * 100 : 0;
  const netMargin = revenue ? (netProfit / revenue) * 100 : 0;
  const roa = statement.totalAssets ? (netProfit / statement.totalAssets) * 100 : 0;
  const roe = statement.totalEquity ? (netProfit / statement.totalEquity) * 100 : 0;

  const currentAssets = (cash + ar + inventory);
  const currentLiabilities = ap;
  const currentRatio = currentLiabilities ? currentAssets / currentLiabilities : 0;
  const quickRatio = currentLiabilities ? (cash + ar) / currentLiabilities : 0;

  const unbalancedEntries = db.prepare(`
    SELECT COUNT(*) AS count
    FROM journal_entries je
    WHERE je.company_id = ? AND je.status = 'posted'
      AND (SELECT COALESCE(SUM(debit),0) FROM journal_lines WHERE entry_id = je.id) !=
          (SELECT COALESCE(SUM(credit),0) FROM journal_lines WHERE entry_id = je.id)
  `).get(companyId).count;

  const outOfPeriod = db.prepare(`
    SELECT COUNT(*) AS count
    FROM journal_entries je
    WHERE je.company_id = ? AND je.status = 'posted'
      AND (je.entry_date < ? OR je.entry_date > ?)
  `).get(companyId, comp.period_from, comp.period_to).count;

  return {
    netProfit,
    cash,
    ar,
    ap,
    inventory,
    grossMargin,
    netMargin,
    roa,
    roe,
    currentRatio,
    quickRatio,
    unbalancedEntries,
    outOfPeriod,
    locked: !!comp.is_locked,
    trialStatus: unbalancedEntries > 0 ? 'Problem' : 'Healthy'
  };
}

function insertAuditLog(companyId, userId, entityType, entityId, action, details) {
  db.prepare(`
    INSERT INTO audit_logs (company_id, user_id, entity_type, entity_id, action, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(companyId, userId, entityType, entityId, action, details || '');
}

function seedChartOfAccounts(companyId, country, activity) {
  const accounts = [
    ['1000', 'النقدية', 'Cash', 'Assets', 'debit'],
    ['1010', 'ذمم مدينة', 'Accounts Receivable', 'Assets', 'debit'],
    ['1020', 'المخزون', 'Inventory', 'Assets', 'debit'],
    ['1030', 'الأصول الثابتة', 'Fixed Assets', 'Assets', 'debit'],
    ['2000', 'الالتزامات الدائنة', 'Accounts Payable', 'Liabilities', 'credit'],
    ['2010', 'ضريبة القيمة المضافة', 'Output VAT Payable', 'Liabilities', 'credit'],
    ['2020', 'ضريبة المدخلات', 'Input VAT Recoverable', 'Assets', 'debit'],
    ['3000', 'رأس المال', 'Share Capital', 'Equity', 'credit'],
    ['3010', 'الأرباح المحتجزة', 'Retained Earnings', 'Equity', 'credit'],
    ['4000', 'إيرادات المبيعات', 'Sales Revenue', 'Revenue', 'credit'],
    ['4010', 'إيرادات أخرى', 'Other Income', 'Revenue', 'credit'],
    ['5000', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'Expenses', 'debit'],
    ['5010', 'إيجار', 'Rent Expense', 'Expenses', 'debit'],
    ['5020', 'مياه وكهرباء', 'Utilities Expense', 'Expenses', 'debit'],
    ['5030', 'رواتب', 'Payroll Expense', 'Expenses', 'debit'],
    ['6000', 'المشتريات', 'Purchases', 'Expenses', 'debit'],
    ['6010', 'تعديلات المخزون', 'Inventory Adjustment', 'Expenses', 'debit'],
    ['7000', 'قروض بنكية', 'Bank Loan', 'Liabilities', 'credit']
  ];

  for (const [code, arName, enName, group, nature] of accounts) {
    db.prepare(`
      INSERT INTO chart_of_accounts (company_id, code, arabic_name, english_name, account_group, nature, is_active, country, activity)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(companyId, code, arName, enName, group, nature, country, activity);
  }
}

function seedSettings(companyId, country, standard, activity, currency, lang) {
  const defaults = {
    Egypt: { vat_rate: 14, income_tax_rate: 20, zakat_rate: 0 },
    'Saudi Arabia': { vat_rate: 15, income_tax_rate: 0, zakat_rate: 2.5 },
    IFRS: { vat_rate: 0, income_tax_rate: 0, zakat_rate: 0 }
  };

  const rateSet = defaults[country] || { vat_rate: 0, income_tax_rate: 0, zakat_rate: 0 };
  db.prepare(`
    INSERT INTO company_settings (company_id, vat_rate, income_tax_rate, zakat_rate, language, date_format, payment_terms)
    VALUES (?, ?, ?, ?, ?, 'YYYY-MM-DD', 'Net 30')
  `).run(companyId, rateSet.vat_rate, rateSet.income_tax_rate, rateSet.zakat_rate, lang || 'en');
}

function createJournalEntry(companyId, userId, { entryNumber, entryType, entryDate, notes, status = 'posted', attachmentPath = null }, lines) {
  const result = db.prepare(`
    INSERT INTO journal_entries (company_id, entry_number, entry_type, entry_date, notes, status, attachment_path, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(companyId, entryNumber, entryType, entryDate, notes, status, attachmentPath, userId);
  const entryId = result.lastInsertRowid;

  for (const line of lines) {
    db.prepare(`
      INSERT INTO journal_lines (company_id, entry_id, account_id, description, debit, credit)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(companyId, entryId, line.accountId, line.description || '', Number(line.debit || 0), Number(line.credit || 0));
  }
  return entryId;
}

function seedDemoCompanies() {
  const count = db.prepare('SELECT COUNT(*) AS total FROM companies').get().total;
  if (count > 0) return;

  const demoCompanies = [
    {
      name: 'Demo Egypt Trading',
      country: 'Egypt',
      standard: 'Egypt',
      activity: 'Trading',
      currency: 'EGP',
      periodFrom: '2025-01-01',
      periodTo: '2025-12-31',
      email: 'owner.egypt@example.com',
      password: 'Owner123!'
    },
    {
      name: 'Demo Saudi Trading',
      country: 'Saudi Arabia',
      standard: 'Saudi',
      activity: 'Trading',
      currency: 'SAR',
      periodFrom: '2025-01-01',
      periodTo: '2025-12-31',
      email: 'owner.saudi@example.com',
      password: 'Owner123!'
    }
  ];

  for (const companyData of demoCompanies) {
    const companyResult = db.prepare(`
      INSERT INTO companies (name, country, standard, activity, currency, fiscal_year_start, fiscal_year_end, period_from, period_to, is_locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      companyData.name,
      companyData.country,
      companyData.standard,
      companyData.activity,
      companyData.currency,
      companyData.periodFrom,
      companyData.periodTo,
      companyData.periodFrom,
      companyData.periodTo
    );
    const companyId = companyResult.lastInsertRowid;
    seedSettings(companyId, companyData.country, companyData.standard, companyData.activity, companyData.currency, 'en');
    seedChartOfAccounts(companyId, companyData.country, companyData.activity);

    const hash = bcrypt.hashSync(companyData.password, 10);
    const userResult = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, language)
      VALUES (?, ?, ?, ?, ?)
    `).run(companyData.email, hash, 'Demo', companyData.country === 'Egypt' ? 'Owner' : 'Manager', 'en');
    const userId = userResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO user_companies (user_id, company_id, role, is_owner)
      VALUES (?, ?, 'owner', 1)
    `).run(userId, companyId);

    const accountMap = {};
    const rows = db.prepare('SELECT * FROM chart_of_accounts WHERE company_id = ?').all(companyId);
    for (const row of rows) {
      accountMap[row.code] = row.id;
    }

    createJournalEntry(companyId, userId, {
      entryNumber: 'OB-1001',
      entryType: 'Opening',
      entryDate: companyData.periodFrom,
      notes: 'Opening balances',
      status: 'posted'
    }, [
      { accountId: accountMap['1000'], debit: 150000, credit: 0, description: 'Opening cash balance' },
      { accountId: accountMap['1010'], debit: 65000, credit: 0, description: 'Opening receivables' },
      { accountId: accountMap['1020'], debit: 90000, credit: 0, description: 'Opening inventory' },
      { accountId: accountMap['2000'], debit: 0, credit: 50000, description: 'Opening payables' },
      { accountId: accountMap['3000'], debit: 0, credit: 255000, description: 'Share capital' }
    ]);

    createJournalEntry(companyId, userId, {
      entryNumber: 'J-1001',
      entryType: 'Sales',
      entryDate: '2025-01-15',
      notes: 'Quarterly invoice',
      status: 'posted'
    }, [
      { accountId: accountMap['1010'], debit: 63000, credit: 0, description: 'Accounts receivable' },
      { accountId: accountMap['2010'], debit: 0, credit: 7000, description: 'Output VAT' },
      { accountId: accountMap['4000'], debit: 0, credit: 56000, description: 'Sales revenue' }
    ]);

    createJournalEntry(companyId, userId, {
      entryNumber: 'J-1002',
      entryType: 'Purchase',
      entryDate: '2025-01-20',
      notes: 'Inventory purchase',
      status: 'posted'
    }, [
      { accountId: accountMap['6000'], debit: 45000, credit: 0, description: 'Purchases' },
      { accountId: accountMap['2020'], debit: 6300, credit: 0, description: 'Input VAT' },
      { accountId: accountMap['2000'], debit: 0, credit: 51300, description: 'Accounts payable' }
    ]);

    createJournalEntry(companyId, userId, {
      entryNumber: 'J-1003',
      entryType: 'Expense',
      entryDate: '2025-02-05',
      notes: 'Rent expense',
      status: 'posted'
    }, [
      { accountId: accountMap['5010'], debit: 12000, credit: 0, description: 'Rent expense' },
      { accountId: accountMap['1000'], debit: 0, credit: 12000, description: 'Cash payment' }
    ]);

    insertAuditLog(companyId, userId, 'company', companyId, 'created', 'Initial demo company seeded');
    insertAuditLog(companyId, userId, 'journal', 1, 'seeded', 'Demo transactions inserted');
  }
}

seedDemoCompanies();

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.render('login', {
    title: 'Login',
    error: null,
    user: null,
    company: null,
    lang: 'en',
    dir: 'ltr',
    t: translations.en,
    csrfToken: req.csrfToken()
  });
});

app.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', {
      title: 'Login',
      error: 'Invalid email or password',
      user: null,
      company: null,
      lang: 'en',
      dir: 'ltr',
      t: translations.en,
      csrfToken: req.csrfToken()
    });
  }

  req.session.userId = user.id;
  req.session.lang = user.language || 'en';
  const membership = db.prepare('SELECT company_id FROM user_companies WHERE user_id = ? ORDER BY id LIMIT 1').get(user.id);
  req.session.companyId = membership ? membership.company_id : null;
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  res.render('register', {
    title: 'Register Company',
    error: null,
    user: null,
    company: null,
    lang: 'en',
    dir: 'ltr',
    t: translations.en,
    csrfToken: req.csrfToken()
  });
});

app.post('/register', (req, res) => {
  const payload = {
    firstName: (req.body.firstName || '').trim(),
    lastName: (req.body.lastName || '').trim(),
    email: (req.body.email || '').trim().toLowerCase(),
    password: req.body.password || '',
    companyName: (req.body.companyName || '').trim(),
    country: req.body.country || 'Egypt',
    standard: req.body.standard || 'Egypt',
    activity: req.body.activity || 'Trading',
    currency: req.body.currency || 'EGP',
    language: req.body.language || 'en'
  };

  if (!payload.firstName || !payload.email || !payload.companyName || !payload.password) {
    return res.status(400).render('register', {
      title: 'Register Company',
      error: 'All required fields are required.',
      user: null,
      company: null,
      lang: 'en',
      dir: 'ltr',
      t: translations.en,
      csrfToken: req.csrfToken()
    });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(payload.email);
  if (existing) {
    return res.status(400).render('register', {
      title: 'Register Company',
      error: 'An account with this email already exists.',
      user: null,
      company: null,
      lang: 'en',
      dir: 'ltr',
      t: translations.en,
      csrfToken: req.csrfToken()
    });
  }

  const companyResult = db.prepare(`
    INSERT INTO companies (name, country, standard, activity, currency, fiscal_year_start, fiscal_year_end, period_from, period_to, is_locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(payload.companyName, payload.country, payload.standard, payload.activity, payload.currency, '2025-01-01', '2025-12-31', '2025-01-01', '2025-12-31');
  const companyId = companyResult.lastInsertRowid;
  seedSettings(companyId, payload.country, payload.standard, payload.activity, payload.currency, payload.language);
  seedChartOfAccounts(companyId, payload.country, payload.activity);

  const userResult = db.prepare(`
    INSERT INTO users (email, password_hash, first_name, last_name, language)
    VALUES (?, ?, ?, ?, ?)
  `).run(payload.email, bcrypt.hashSync(payload.password, 10), payload.firstName, payload.lastName, payload.language);
  const userId = userResult.lastInsertRowid;

  db.prepare(`
    INSERT INTO user_companies (user_id, company_id, role, is_owner)
    VALUES (?, ?, 'owner', 1)
  `).run(userId, companyId);

  insertAuditLog(companyId, userId, 'company', companyId, 'created', 'New company created by owner');
  req.session.userId = userId;
  req.session.companyId = companyId;
  req.session.lang = payload.language;
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/dashboard', requireAuth, (req, res) => {
  const company = getCompany(req.session.companyId);
  const companyAdmin = getUserCompanyRole(req.session.userId, req.session.companyId);
  const metrics = buildDashboardMetrics(req.session.companyId);
  const accounts = accountTotalsByCompany(req.session.companyId);
  const healthChecks = [
    {
      label: 'Unbalanced entries',
      value: metrics.unbalancedEntries,
      status: metrics.unbalancedEntries === 0 ? 'ok' : 'warning'
    },
    {
      label: 'Dates outside fiscal period',
      value: metrics.outOfPeriod,
      status: metrics.outOfPeriod === 0 ? 'ok' : 'warning'
    },
    {
      label: 'Period lock',
      value: company.is_locked ? 'Locked' : 'Open',
      status: company.is_locked ? 'warning' : 'ok'
    },
    {
      label: 'Trial balance',
      value: metrics.trialStatus,
      status: metrics.trialStatus === 'Healthy' ? 'ok' : 'warning'
    }
  ];

  res.render('dashboard', {
    title: 'Dashboard',
    company,
    role: companyAdmin,
    metrics,
    accounts,
    healthChecks,
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.get('/company', requireAuth, (req, res) => {
  const company = ensureCompanyProfile(req.session.companyId);
  res.render('company', {
    title: 'Company Profile',
    company,
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.post('/company/update', requireAuth, (req, res) => {
  const company = getCompany(req.session.companyId);
  const role = getUserCompanyRole(req.session.userId, req.session.companyId);
  if (role !== 'owner') {
    return res.status(403).send('Only the owner can update company settings');
  }
  db.prepare(`
    UPDATE companies SET name = ?, country = ?, standard = ?, activity = ?, currency = ? WHERE id = ?
  `).run(req.body.name || company.name, req.body.country || company.country, req.body.standard || company.standard, req.body.activity || company.activity, req.body.currency || company.currency, company.id);

  db.prepare(`
    UPDATE company_settings SET vat_rate = ?, income_tax_rate = ?, zakat_rate = ?, language = ? WHERE company_id = ?
  `).run(Number(req.body.vat_rate || 0), Number(req.body.income_tax_rate || 0), Number(req.body.zakat_rate || 0), req.body.language || req.session.lang || 'en', company.id);

  insertAuditLog(company.id, req.session.userId, 'company', company.id, 'updated', 'Company settings updated');
  res.redirect('/company');
});

app.post('/company/toggle-lock', requireAuth, (req, res) => {
  const company = getCompany(req.session.companyId);
  const role = getUserCompanyRole(req.session.userId, req.session.companyId);
  if (role !== 'owner') {
    return res.status(403).send('Only the owner can lock or unlock the period');
  }
  const nextLock = company.is_locked ? 0 : 1;
  db.prepare('UPDATE companies SET is_locked = ? WHERE id = ?').run(nextLock, company.id);
  insertAuditLog(company.id, req.session.userId, 'company', company.id, nextLock ? 'locked' : 'unlocked', `Period ${nextLock ? 'locked' : 'unlocked'} by owner`);
  res.redirect('/company');
});

app.get('/coa', requireAuth, (req, res) => {
  const accounts = db.prepare('SELECT * FROM chart_of_accounts WHERE company_id = ? ORDER BY code').all(req.session.companyId);
  const trial = accountTotalsByCompany(req.session.companyId);
  res.render('coa', {
    title: 'Chart of Accounts',
    accounts,
    trial,
    user: currentUser(req),
    company: getCompany(req.session.companyId),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.post('/coa/toggle', requireAuth, (req, res) => {
  const role = getUserCompanyRole(req.session.userId, req.session.companyId);
  if (!['owner', 'accountant'].includes(role)) return res.status(403).send('Insufficient permissions');
  const accountId = Number(req.body.accountId);
  const account = db.prepare('SELECT * FROM chart_of_accounts WHERE id = ? AND company_id = ?').get(accountId, req.session.companyId);
  if (!account) return res.status(404).send('Account not found');
  const nextState = account.is_active ? 0 : 1;
  db.prepare('UPDATE chart_of_accounts SET is_active = ? WHERE id = ?').run(nextState, accountId);
  insertAuditLog(req.session.companyId, req.session.userId, 'chart_of_accounts', accountId, 'toggle_active', `Account ${account.code} set to ${nextState ? 'active' : 'inactive'}`);
  res.redirect('/coa');
});

app.get('/journal', requireAuth, (req, res) => {
  const companyId = req.session.companyId;
  const entries = db.prepare(`
    SELECT je.*, u.email AS user_email
    FROM journal_entries je
    LEFT JOIN users u ON u.id = je.created_by
    WHERE je.company_id = ?
    ORDER BY je.entry_date DESC, je.id DESC
  `).all(companyId);
  res.render('journal', {
    title: 'Journals',
    entries,
    company: getCompany(companyId),
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.get('/journal/new', requireAuth, (req, res) => {
  const companyId = req.session.companyId;
  const accounts = db.prepare('SELECT * FROM chart_of_accounts WHERE company_id = ? AND is_active = 1 ORDER BY code').all(companyId);
  res.render('journal-new', {
    title: 'New Journal Entry',
    accounts,
    error: null,
    company: getCompany(companyId),
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.post('/journal/new', requireAuth, (req, res) => {
  const role = getUserCompanyRole(req.session.userId, req.session.companyId);
  if (!['owner', 'accountant', 'invoice clerk'].includes(role)) return res.status(403).send('Insufficient role');

  const company = getCompany(req.session.companyId);
  if (company.is_locked && role !== 'owner') {
    return res.status(403).send('This period is locked. Only the owner can unlock it.');
  }

  const accountIds = Array.isArray(req.body.accountId) ? req.body.accountId : [req.body.accountId];
  const debits = Array.isArray(req.body.debit) ? req.body.debit : [req.body.debit];
  const credits = Array.isArray(req.body.credit) ? req.body.credit : [req.body.credit];
  const descriptions = Array.isArray(req.body.description) ? req.body.description : [req.body.description];
  const lines = [];
  let totalDebit = 0;
  let totalCredit = 0;

  for (let i = 0; i < accountIds.length; i++) {
    const accountId = Number(accountIds[i]);
    const debit = Number(debits[i] || 0);
    const credit = Number(credits[i] || 0);
    const desc = descriptions[i] || '';
    if (!accountId) continue;
    const account = db.prepare('SELECT * FROM chart_of_accounts WHERE id = ? AND company_id = ?').get(accountId, req.session.companyId);
    if (!account || !account.is_active) {
      return res.status(400).send('Invalid or inactive account');
    }
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      return res.status(400).send('Each line must be either debit or credit');
    }
    totalDebit += debit;
    totalCredit += credit;
    lines.push({ accountId, description: desc, debit, credit });
  }

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    return res.status(400).send('Journal entry is not balanced');
  }

  const entryType = req.body.entryType || 'Other';
  const entryDate = req.body.entryDate || new Date().toISOString().slice(0, 10);
  const entryNumber = req.body.entryNumber || `J-${Date.now()}`;

  const entryId = createJournalEntry(req.session.companyId, req.session.userId, {
    entryNumber,
    entryType,
    entryDate,
    notes: req.body.notes || '',
    status: 'posted'
  }, lines);

  insertAuditLog(req.session.companyId, req.session.userId, 'journal', entryId, 'created', `Journal ${entryNumber} posted`);
  res.redirect('/journal');
});

app.post('/journal/:id/reverse', requireAuth, (req, res) => {
  const role = getUserCompanyRole(req.session.userId, req.session.companyId);
  if (!['owner', 'accountant'].includes(role)) return res.status(403).send('Only owner/accountant can reverse entries');

  const entry = db.prepare('SELECT * FROM journal_entries WHERE id = ? AND company_id = ?').get(Number(req.params.id), req.session.companyId);
  if (!entry) return res.status(404).send('Entry not found');

  const reversalNumber = `RV-${entry.entry_number}`;
  const lines = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(entry.id).map(line => ({
    accountId: line.account_id,
    description: `Reversal of ${entry.entry_number}`,
    debit: Number(line.credit || 0),
    credit: Number(line.debit || 0)
  }));

  const reversalId = createJournalEntry(req.session.companyId, req.session.userId, {
    entryNumber: reversalNumber,
    entryType: 'Adjustment',
    entryDate: new Date().toISOString().slice(0, 10),
    notes: `Reversal of ${entry.entry_number}`,
    status: 'posted'
  }, lines);

  db.prepare('UPDATE journal_entries SET status = ? WHERE id = ?').run('reversed', entry.id);
  insertAuditLog(req.session.companyId, req.session.userId, 'journal', entry.id, 'reversed', `Entry ${entry.entry_number} reversed by ${reversalNumber}`);
  res.redirect('/journal');
});

app.get('/ledger', requireAuth, (req, res) => {
  const accountRows = accountTotalsByCompany(req.session.companyId);
  res.render('ledger', {
    title: 'General Ledger',
    accounts: accountRows,
    company: getCompany(req.session.companyId),
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.get('/ledger/:accountId', requireAuth, (req, res) => {
  const accountId = Number(req.params.accountId);
  const account = db.prepare('SELECT * FROM chart_of_accounts WHERE id = ? AND company_id = ?').get(accountId, req.session.companyId);
  if (!account) return res.status(404).send('Account not found');

  const ledgerLines = db.prepare(`
    SELECT je.entry_date, je.entry_number, je.entry_type, jl.description, jl.debit, jl.credit,
      (SELECT SUM(COALESCE(jl2.debit,0) - COALESCE(jl2.credit,0))
       FROM journal_lines jl2
       JOIN journal_entries je2 ON je2.id = jl2.entry_id
       WHERE je2.company_id = ? AND je2.status = 'posted' AND je2.entry_date <= je.entry_date AND jl2.account_id = ? ) AS running_balance
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.company_id = ? AND je.status = 'posted' AND jl.account_id = ?
    ORDER BY je.entry_date ASC, jl.id ASC
  `).all(req.session.companyId, account.id, req.session.companyId, account.id);

  res.render('ledger-detail', {
    title: 'Ledger Detail',
    account,
    ledgerLines,
    company: getCompany(req.session.companyId),
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.get('/trial-balance', requireAuth, (req, res) => {
  const balanceRows = accountTotalsByCompany(req.session.companyId).map(row => {
    const debit = Number(row.total_debit || 0);
    const credit = Number(row.total_credit || 0);
    let balance = 0;
    if (row.nature === 'debit') balance = debit - credit;
    else balance = credit - debit;
    return { ...row, debit, credit, balance };
  });

  const totalDebit = balanceRows.reduce((sum, row) => sum + Math.max(row.debit - row.credit, 0), 0);
  const totalCredit = balanceRows.reduce((sum, row) => sum + Math.max(row.credit - row.debit, 0), 0);

  res.render('trial-balance', {
    title: 'Trial Balance',
    rows: balanceRows,
    totalDebit,
    totalCredit,
    company: getCompany(req.session.companyId),
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.get('/statements', requireAuth, (req, res) => {
  const statement = buildFinancialStatement(req.session.companyId);
  const company = getCompany(req.session.companyId);
  res.render('statements', {
    title: 'Financial Statements',
    statement,
    company,
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.get('/audit', requireAuth, (req, res) => {
  const logs = db.prepare(`
    SELECT al.*, u.email
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE al.company_id = ?
    ORDER BY al.created_at DESC
    LIMIT 100
  `).all(req.session.companyId);
  res.render('audit', {
    title: 'Audit Log',
    logs,
    company: getCompany(req.session.companyId),
    user: currentUser(req),
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.post('/language', requireAuth, (req, res) => {
  const selected = req.body.language === 'ar' ? 'ar' : 'en';
  applyLanguage(req, selected);
  res.redirect('/dashboard');
});

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    message: 'The page you requested does not exist.',
    user: currentUser(req),
    company: req.session.companyId ? getCompany(req.session.companyId) : null,
    lang: req.session.lang || 'en',
    dir: (req.session.lang || 'en') === 'ar' ? 'rtl' : 'ltr',
    t: translations[req.session.lang || 'en']
  });
});

app.listen(PORT, () => {
  console.log(`SME Accounting app running at http://localhost:${PORT}`);
  console.log('Demo logs:');
  console.log('Egypt owner: owner.egypt@example.com / Owner123!');
  console.log('Saudi owner: owner.saudi@example.com / Owner123!');
});
