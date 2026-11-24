'use strict';
/* Topics read from the titles of public stages (podcast episodes, panels, webinars, talks, articles).
 * A fixed keyword list per topic, in English and French, published on the method page: the same rule for every stage,
 * nothing guessed by a model. The series name before the first colon is dropped ("FORECAST podcast: ..." is not a
 * talk about cash forecasting), and so are bracketed notes ("(sponsored by ...)", "(with ...)"). */
const RULES = {
  'AI in finance': [/\bAI\b/, /\bIA\b/, /artificial intelligence/i, /intelligence artificielle/i, /\bgen ?AI\b/i, /generative/i, /g[ée]n[ée]rative/i, /agentic/i, /\bAI agents?\b/i, /machine learning/i, /\bLLMs?\b/, /chatgpt/i, /copilot/i],
  'Payments': [/\bpayments?\b/i, /\bpaiements?\b/i, /\bvirements?\b/i, /real[- ]time (payments?|rails|settlement)/i, /instant payments?/i, /ISO ?20022/i, /cross[- ]border/i, /\bSEPA\b/, /\bFedNow\b/i, /\bRTP\b/, /virtual cards?/i],
  'Treasury technology': [/treasury tech/i, /\btech(nology)? (in|for) treasury/i, /digital(i[sz]ation|i[sz]ing)? (of )?(the )?treasury/i, /treasury (digital|transformation|automation|tools)/i, /transform(ing|ation of)? (the )?treasury/i, /\bautomation\b/i, /\bautomati[sz]/i, /\bfintechs?\b/i, /transformation digitale/i, /digitalisation/i, /syst[eè]mes? d'information/i, /tr[ée]sorerie (digitale|num[ée]rique)/i],
  'Cash forecasting': [/cash[- ]?(flow )?forecast/i, /forecasting (cash|liquidity)/i, /pr[ée]visions? de tr[ée]sorerie/i, /pr[ée]vision de cash/i, /cash visibility/i, /visibilit[ée] (de|sur) (la )?tr[ée]sorerie/i],
  'Liquidity': [/liquidit/i, /cash management/i, /managing cash/i, /cash positioning/i, /gestion de (la )?tr[ée]sorerie/i, /money market/i, /\bMMFs?\b/, /short[- ]term invest/i, /\bplacements?\b/i, /idle cash/i, /excess cash/i],
  'FP&A & planning': [/\bFP&A\b/i, /\bFP ?& ?A\b/i, /planning/i, /\bbudget/i, /rolling forecast/i, /scenario/i, /sc[ée]nario/i, /planification/i, /contr[ôo]le de gestion/i, /business partner/i, /financial model/i, /unit economics/i, /\bKPIs?\b/, /\bmetrics\b/i, /\bforecast(s|ing)?\b(?! ?(de )?tr[ée]sorerie)(?!.*cash)/i],
  /* risk is split three ways: market and counterparty risk (FX has its own topic), operational risk, regulation */
  'Market risk': [/market risk/i, /risques? de march[ée]/i, /interest[- ]rate risk/i, /risques? de taux/i, /counterparty/i, /contrepartie/i, /credit risk/i, /risques? de cr[ée]dit/i, /financial risks?/i, /risques? financiers?/i, /treasury risk/i, /\brisk management\b/i, /gestion des risques/i, /gestion du risque/i, /volatil/i, /\bVaR\b/, /settlement risk/i, /geopolitical risk/i, /\bcredit\b.{0,20}\brisk/i, /risk optimi/i, /risques? g[ée]opolitiques?/i],
  'Operational risk': [/operational risk/i, /risques? op[ée]rationnels?/i, /resilien/i, /r[ée]silien/i, /cyber/i, /business continuity/i, /continuit[ée] d'activit[ée]/i, /internal controls?/i, /contr[ôo]le interne/i, /\bcontrols\b/i, /segregation of duties/i, /\bDORA\b/, /security/i, /s[ée]curit[ée]/i, /quantum[- ]safe/i, /outage/i, /payment risk/i],
  'Regulation & compliance': [/compliance/i, /conformit[ée]/i, /regulat/i, /r[ée]glementa/i, /r[ée]gulat/i, /sanctions/i, /\bKYC\b/, /\bAML\b/, /anti[- ]money/i, /\bBasel\b/i, /\bB[âa]le\b/, /\bEMIR\b/, /\bMiFID/i, /\bPSD[23]\b/, /\bPSR\b/, /\btax(es|ation)?\b/i, /fiscal/i, /\bpolicy\b/i, /financial crime/i, /governance/i, /gouvernance/i],
  'Fraud': [/fraud/i, /\bscams?\b/i, /\bBEC\b/, /arnaque/i, /usurpation/i],
  'Bank connectivity': [/bank(ing)? connectivity/i, /connectivit[ée] bancaire/i, /\bAPIs?\b/, /open (banking|finance)/i, /\bEBICS\b/i, /host[- ]to[- ]host/i, /\bSWIFT (connectivity|gpi|for corporates)/i, /bank account management/i, /\beBAM\b/i, /bank (statements?|formats?)/i],
  'Debt & funding': [/\bdebt\b/i, /\bdettes?\b/i, /\bfunding\b/i, /\bfinancement/i, /\bfinancing\b/i, /capital markets?/i, /\bbonds?\b/i, /\bloans?\b/i, /\bcr[ée]dits?\b/i, /credit rating/i, /\bnotation\b/i, /refinanc/i, /private credit/i, /\bborrow/i, /\bleverage/i, /\bM&A\b/],
  'Working capital': [/working capital/i, /\bBFR\b/, /fonds de roulement/i, /cash conversion/i, /\bDSO\b/, /\bDPO\b/, /supply chain financ/i, /receivables financ/i, /\bfactoring\b/i, /affacturage/i, /trade finance/i, /financement du commerce/i],
  'ESG & sustainable finance': [/\bESG\b/, /sustainab/i, /\bdurab/i, /climat/i, /\bgreen\b/i, /\bvert(e|es)?\b/i, /\bCSRD\b/, /net[- ]zero/i, /carbon/i, /carbone/i, /impact invest/i],
  'FX & hedging': [/\bFX\b/, /foreign exchange/i, /\bcurrenc/i, /\bdevises?\b/i, /(risque|taux|march[ée]) de change/i, /\bhedg/i, /couverture/i, /d[ée]riv[ée]s/i, /derivatives?/i, /interest[- ]rate (risk|hedg|swap)/i, /taux d'int[ée]r[êe]t/i],
  'Crypto & stablecoins': [/crypto/i, /stablecoin/i, /digital assets?/i, /actifs? num[ée]riques?/i, /tokeni[sz]/i, /blockchain/i, /bitcoin/i, /\bCBDCs?\b/, /\bDLT\b/, /\bweb ?3\b/i],
  'AR/AP': [/accounts? (payable|receivable)/i, /\bAP automation/i, /\bAR automation/i, /procure[- ]to[- ]pay/i, /\bP2P\b/, /order[- ]to[- ]cash/i, /\bO2C\b/, /contract[- ]to[- ]cash/i, /invoic/i, /factur(e|ation)/i, /\bcollections?\b/i, /recouvrement/i, /procurement/i, /\bachats?\b/i, /expense management/i, /spend management/i],
  'In-house banking': [/in[- ]house bank/i, /\bIHB\b/, /cash pool/i, /\bnetting\b/i, /\bPOBO\b/, /\bCOBO\b/, /centrali[sz]ation de (la )?tr[ée]sorerie/i, /treasury centre/i, /treasury center/i, /virtual accounts?/i, /virtual bank/i, /comptes? virtuels?/i, /intercompany/i, /intra[- ]company/i],
  'TMS selection': [/\bTMS\b/, /treasury management system/i, /\bRFPs?\b/, /(vendor|system|software|technology) selection/i, /choisir (son|un|votre) (TMS|logiciel)/i, /selecting a (TMS|system|vendor)/i, /implementation/i, /impl[ée]mentation/i],
  'Consolidation': [/consolidation/i, /\bclose\b/i, /closing the books/i, /cl[ôo]ture/i, /\bIFRS\b/, /financial reporting/i, /reporting financier/i, /\bSOX\b/],
  'Commodities': [/commodit/i, /mati[èe]res? premi[èe]res?/i, /\benergy\b/i, /[ée]nergie/i, /\bmetals?\b/i, /\boil\b/i, /\bgas prices?\b/i]
};
const TOPICS = Object.keys(RULES);
/* award pages and press releases about a company are not a person speaking on a topic */
const NOT_SPOKEN = /\bawards?\b|\bwinners?\b|\bpictured\b|\bpress release\b|\bnominat/i;

/* the part of a stage label that names its subject: after the series name, without brackets and dates */
function subject(label) {
  let s = String(label || '');
  const q = s.match(/(?:^|[\s,(])['‘“"«](.{8,}?)['’”"»](?=\s*(?:\(|,|\.|$))/);
  if (q) s = q[1];
  else { const i = s.indexOf(': '); if (i > 0 && i < 60) s = s.slice(i + 2); }
  s = s.replace(/^[^:'‘"“]{0,40}#\s?\d+\s*[,:–-]?\s*/, ''); /* "FORECAST #26, ..." : a series and an episode number */
  return s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}
function topicsOf(label) {
  if (!label || NOT_SPOKEN.test(label)) return [];
  const s = subject(label);
  return TOPICS.filter(t => RULES[t].some(re => re.test(s)));
}
/* public form of the rules, for the method page */
const RULES_TEXT = TOPICS.map(t => ({ topic: t, words: RULES[t].map(r => r.source.replace(/\\b/g, '').replace(/\\/g, '')) }));

module.exports = { TOPICS, RULES, topicsOf, subject, RULES_TEXT, NOT_SPOKEN };
