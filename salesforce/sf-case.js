/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// The case's own fields, over GraphQL, in the shapes the panel takes: toData for the case's sync, toBrief for a queue
// row. Loaded by the panel after sf-graphql.js. Classic script. Exposes globalThis.SfCase. Read-only. Every query names
// its fields one by one, because License_Instance__c also holds credentials, and no query here may ever select those.
globalThis.SfCase ??= (() => {
  const CASE_FIELDS =
    'Id CaseNumber { value } Subject { value } Description { value } Status { value displayValue } Priority { value displayValue } Product__c { value displayValue } Version__c { value displayValue } License_Type__c { value } Support_Language__c { value displayValue } Case_Age_in_days__c { value } Entitlement_Name__c { value } JIRA_Number__c { value } NPS_90_day_Average__c { value } NPS_365_days_Average__c { value } Is_Case_Escalated__c { value } AssetId { value } AccountId { value }';
  // In a query of their own: a relationship this user cannot follow fails only them.
  const PEOPLE =
    'query q($id: ID) { uiapi { query { Case(where: { Id: { eq: $id } }, first: 1) { edges { node { Owner { ... on User { Name { value } } ... on Group { Name { value } } } Temporary_Case_Owner__r { Name { value } } LastModifiedBy { Name { value } Alias { value } } Account { Name { value } } Contact { Name { value } } Asset { Name { value } SerialNumber { value } } } } } } } }';
  const INSTANCE = 'query q($id: ID) { uiapi { query { License_Instance__c(where: { Asset__c: { eq: $id } }, first: 1) { edges { node { Is_Cloud__c { value } } } } } } }';

  /* THE ADDITIONAL INFORMATION SECTION of the case page (Beta 9.8.4, the maintainer, 2026-11-16: "LET ALL DETAILS IN THE
   * ADDITIONAL INFORMATION FIELD ON SALESFORCE PER CASE BE SENT TO THE ENDPOINT TOO"), in the page's order, by the API
   * names the page itself carries (data-target-selection-name). A lookup is read by its record's Name. Asked in one query;
   * if Salesforce refuses it (a field this user cannot read), each field is asked on its own, so one refusal costs one
   * field. Nothing here is a credential. */
  const ADDITIONAL = [
    { api: 'Operation_Category__c', label: 'Operation Category' },
    { api: 'Product__c', label: 'Product' },
    { api: 'Type', label: 'Case Type' },
    { api: 'Version__c', label: 'Current Version' },
    { api: 'Case_Topic__c', label: 'Case Topic' },
    { api: 'Cloud_Upgrade_Requested_Version__c', label: 'Cloud Upgrade - Requested Version' },
    { api: 'Case_Sub_Topic__c', label: 'Case Sub-Topic' },
    { api: 'JIRA_Number__c', label: 'JIRA Number' },
    { api: 'Device_OS__c', label: 'Device OS' },
    { api: 'JIRA_Ticket_Closed__c', label: 'JIRA Ticket Closed' },
    { api: 'Manufacturer__c', label: 'Manufacturer', rel: 'Manufacturer__r' },
    { api: 'Cloud_Ticket_Number__c', label: 'Cloud Ticket Number' },
    { api: 'Device_Type_Model__c', label: 'Device Model' },
    { api: 'Request_For_Upgrade__c', label: 'Request For Cloud Upgrade' },
    { api: 'Device_OS_Version__c', label: 'Device OS Version' },
    { api: 'Cloud_Upgrade_Owner__c', label: 'Cloud Upgrade Owner', rel: 'Cloud_Upgrade_Owner__r' },
    { api: 'Agent_Version_Build__c', label: 'Agent Version / Build' },
    { api: 'Upgrade_Region_Performed__c', label: 'Upgrade Region (Performed)' },
    { api: 'Server_Name__c', label: 'Server Name' },
    { api: 'Upgrade_Date__c', label: 'Upgrade Date' },
  ];
  const addlField = (f) => (f.rel ? `${f.rel} { Name { value } }` : `${f.api} { value displayValue }`);
  const addlQuery = (fields) => `query q($id: ID) { uiapi { query { Case(where: { Id: { eq: $id } }, first: 1) { edges { node { Id ${fields.map(addlField).join(' ')} } } } } } }`;
  // A field's words as the page shows them: a picklist's label, a checkbox as Yes / No, a lookup's Name.
  function addlText(node, f) {
    if (!node) return null;
    if (f.rel) { if (!(f.rel in node)) return null; return String(node[f.rel]?.Name?.value ?? ''); }
    if (!(f.api in node)) return null;
    const x = node[f.api];
    const v = x?.displayValue ?? x?.value;
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return v == null ? '' : String(v);
  }
  // [{ label, api, value }] for every field the user may read, in the page's order ('' for an empty field). Never throws.
  async function readAdditional(id) {
    try {
      const all = await globalThis.SfGraphql.run({ addl: { text: addlQuery(ADDITIONAL), variables: { id } } });
      let node = all?.results?.addl?.uiapi?.query?.Case?.edges?.[0]?.node ?? null;
      const got = {};
      if (node) for (const f of ADDITIONAL) got[f.api] = addlText(node, f);
      else {
        if (!all) return null;
        const one = await globalThis.SfGraphql.run(Object.fromEntries(ADDITIONAL.map((f, i) => [`a${i}`, { text: addlQuery([f]), variables: { id } }])));
        if (!one) return null;
        ADDITIONAL.forEach((f, i) => { const n = one.results?.[`a${i}`]?.uiapi?.query?.Case?.edges?.[0]?.node; got[f.api] = n ? addlText(n, f) : null; });
      }
      return ADDITIONAL.filter((f) => got[f.api] !== null).map((f) => ({ label: f.label, api: f.api, value: got[f.api].trim() }));
    } catch { return null; }
  }

  const value = (field) => field?.value ?? '';
  // What the page shows: `value` is a picklist's API name, which may differ from its label.
  const shown = (field) => field?.displayValue ?? field?.value ?? '';
  const first = (data) => data?.uiapi?.query?.Case?.edges?.[0]?.node ?? null;

  // Never throws. Null when no tab can read, or the org has no such case.
  async function read({ recordId, caseNumber } = {}) {
    if (!recordId && !caseNumber) return null;
    const text = `query q($v: ${recordId ? 'ID' : 'String'}) { uiapi { query { Case(where: { ${recordId ? 'Id' : 'CaseNumber'}: { eq: $v } }, first: 1) { edges { node { ${CASE_FIELDS} } } } } } }`;
    const reply = await globalThis.SfGraphql.run({ case: { text, variables: { v: recordId || caseNumber } } });
    const c = first(reply?.results.case);
    if (!c) return null;
    const assetId = value(c.AssetId);
    // The people, the license instance and Additional Information need only the case's id: read side by side
    // (2026-11-18, "THIS GRAPHQL TENDS TO TAKE LONG SOMETIMES"), where they used to be two round trips in a row.
    const [more, additional] = await Promise.all([
      globalThis.SfGraphql.run({
        people: { text: PEOPLE, variables: { id: c.Id } },
        ...(assetId ? { instance: { text: INSTANCE, variables: { id: assetId } } } : {}),
      }),
      readAdditional(c.Id),
    ]);
    const people = first(more?.results.people);
    const isCloud = more?.results.instance?.uiapi?.query?.License_Instance__c?.edges?.[0]?.node?.Is_Cloud__c?.value;
    const escalated = c.Is_Case_Escalated__c?.value;
    return {
      id: c.Id,
      origin: reply.origin,
      caseNumber: value(c.CaseNumber),
      subject: value(c.Subject),
      description: value(c.Description),
      status: shown(c.Status),
      priority: shown(c.Priority),
      product: shown(c.Product__c),
      version: shown(c.Version__c),
      licenseType: value(c.License_Type__c),
      language: shown(c.Support_Language__c),
      age: c.Case_Age_in_days__c?.value ?? null,
      entitlement: value(c.Entitlement_Name__c),
      jira: value(c.JIRA_Number__c),
      nps90: value(c.NPS_90_day_Average__c),
      nps365: value(c.NPS_365_days_Average__c),
      escalated: typeof escalated === 'boolean' ? escalated : null,
      assetId,
      accountId: value(c.AccountId),
      owner: value(people?.Owner?.Name),
      tempOwner: value(people?.Temporary_Case_Owner__r?.Name),
      lastModifiedBy: value(people?.LastModifiedBy?.Alias) || value(people?.LastModifiedBy?.Name),
      accountName: value(people?.Account?.Name),
      contactName: value(people?.Contact?.Name),
      assetName: value(people?.Asset?.Name),
      assetSerial: value(people?.Asset?.SerialNumber),
      isCloud: typeof isCloud === 'boolean' ? isCloud : null,
      additional,
    };
  }

  const caseUrl = (facts) => `${facts.origin}/lightning/r/Case/${facts.id}/view`;
  const assetUrl = (facts) => (facts.assetId ? `${facts.origin}/lightning/r/Asset/${facts.assetId}/view` : '');
  const ageText = (facts) => (facts.age === null ? '' : String(facts.age));
  const issueKey = (raw) => {
    const m = String(raw ?? '').toUpperCase().match(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/);
    return m ? `${m[1]}-${m[2]}` : '';
  };

  // The fields of the case's sync. Pure. No field says who hosts it, so mcHosted stays empty: the panel takes it from
  // the license type, then from isCloud.
  function toData(facts) {
    const scores = [
      { label: 'NPS Score (90 Days Avg)', value: facts.nps90 },
      { label: 'NPS Score (365 Days Avg)', value: facts.nps365 },
    ].filter((score) => score.value);
    return {
      caseNumber: facts.caseNumber,
      caseStatus: facts.status,
      contactName: facts.contactName,
      accountName: facts.accountName,
      subject: facts.subject,
      description: facts.description,
      currentVersion: facts.version,
      product: facts.product,
      licenseType: facts.licenseType,
      mcHosted: '',
      isCloud: facts.isCloud,
      supportLanguage: facts.language,
      caseAge: ageText(facts),
      // Entitlement Name (Entitlement_Name__c, a formula: "Enterprise Service"…), for its own field in Case Details (2026-11-16).
      entitlement: facts.entitlement,
      npsScores: scores,
      npsAverages: { d90: facts.nps90, d365: facts.nps365 },
      escalated: facts.escalated === null ? '' : facts.escalated ? 'yes' : 'no',
      asset: facts.assetName,
      assetSerial: facts.assetSerial,
      assetUrl: assetUrl(facts),
      caseUrl: caseUrl(facts),
      jiraNumber: issueKey(facts.jira) || facts.jira,
      caseOwner: facts.owner,
      tempCaseOwner: facts.tempOwner,
      lastModifiedBy: facts.lastModifiedBy,
      additionalInfo: Array.isArray(facts.additional) ? facts.additional : null,
    };
  }

  // The fields applyCaseBrief reads, but for the activity. Pure.
  function toBrief(facts) {
    return {
      caseNumber: facts.caseNumber,
      subject: facts.subject,
      description: facts.description,
      owner: facts.owner,
      lastModifiedBy: facts.lastModifiedBy,
      status: facts.status,
      priority: facts.priority,
      licenseType: facts.licenseType,
      product: facts.product,
      contactName: facts.contactName,
      accountName: facts.accountName,
      caseAge: ageText(facts),
      entitlement: facts.entitlement,
      jiraNumber: issueKey(facts.jira),
      recordId: facts.id,
      caseUrl: caseUrl(facts),
      readScope: 'record',
      asset: facts.assetName,
      assetUrl: assetUrl(facts),
      additionalInfo: Array.isArray(facts.additional) ? facts.additional : null,
    };
  }

  return { read, toData, toBrief, readAdditional, ADDITIONAL };
})();
