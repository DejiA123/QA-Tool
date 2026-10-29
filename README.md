# QA Tool

A Chrome side-panel extension for the SOTI Support **QA team**. It reads cases out of
Salesforce, measures how they were handled, and writes the team's QA sheet and coaching
summary.

It is a **separate tool** from the SOTI AI Analyser — its own folder, its own extension, its
own storage. Install both and they sit side by side in the toolbar without touching each
other's settings, cases or reviews.

---

## What's new in 3.1.0

* **An owner dropdown on the Cases tab.** At the end of the tier chips' line, **All owners ▾**
  lists only the people whose cases are loaded — sync Robert's, Daiva's and Callum's cases and
  those are the three names in it, each with how many cases they have. Tick one to see only their
  cases, tick several to see them together, **Clear** (or *All owners*) to see everyone again.
  The tier chips, the search box, **Select all** and **QA selected** all work on what it leaves
  on screen. With more than eight owners a *Find an owner…* box appears at the top of the list.
* **The Reviews tab is filed in folders: the month the case closed, then its owner.** Each
  month folder shows how many reviews and owners it holds and the **average score of every case
  reviewed in it**; each owner folder inside shows that owner's own average. Click a folder to
  open it, or use **Expand all / Collapse all**. Cases still open sit under **Not closed yet**;
  a closed case whose closing date was never read sits under **Closed month not known**. The
  folders you leave open are remembered.
* **A sort on the Reviews tab** — newest or oldest review, score lowest or highest first (which
  also orders the owners in each month by their average), case age, closed date, or case
  number.
* **The closed date is read** — off the case page during a review (*Date/Time Closed*), and off
  any list view or report that carries a closed-date column. A review written before this
  version moves into its month as soon as its case is synced from such a report.
* **Agent Cases is now called EMEA Agent Cases** in Current View. A copy that already has the
  button gets it renamed once; a button you renamed yourself keeps your name.
* **EMEA Closed Cases in Current View**, after EMEA Agent Cases — the report of every closed case in
  EMEA. Sync it, pick the owners being reviewed in the dropdown, QA them, and each review lands
  in its closing month. Offered once; right-click it to rename or forget it.
* **Updates from the shared folder, with a Restart now bar** — the analyser's (Global 1.3.2)
  mechanism. Installed from the OneDrive folder, the tool finds a new signed release in its own
  folder by itself; see [New versions](#new-versions).

## What's new in 3.0.0

* **Copilot works again, the way it does in the SOTI AI Analyser v9.5.4.** Microsoft now
  forwards `m365.cloud.microsoft/chat` to `copilot.cloud.microsoft`, and 2.1.0 could only ever
  be granted the first — so every write-up failed five times with *"Signing in redirected the
  tab to https://copilot.cloud.microsoft"*. The relay files are the analyser's v9.5.4 ones, the
  manifest asks for both hosts, and a **Connect Copilot** dialog asks for them in one click and
  tests the connection straight away. **After installing 3.0.0, press *Grant access to Copilot*
  once** when the dialog appears — Chrome only adds the new host when asked.
* **A locked-out relay stops the run** at the first case instead of asking five times per case;
  a sign-in redirect is told apart from a missing permission and offers *Open Copilot to sign in*.
* **The Cases tab is the analyser's**: Add Case menu, Sync From Salesforce and ↻, Current View,
  the comma-separated filter, tier / JIRA / ★ Focus chips, the Select bar, the cog, the row
  expander and ×, and a right-click menu — with **QA selected** and **30/60/90** on the list bar.
* **Terms of use**, as in the analyser: shown the first time the panel opens (and again when the
  terms change), accepted with *I agree*, recorded on the device with the date, and readable any
  time from **⋮ → Settings → Read the Terms of use**. Settings also carries the ownership notice.
* **The integrity check**, as in the analyser and with the analyser's key: every official copy
  carries `integrity.json`, a SHA-256 of each code file signed by Ayodeji Augustine. At start-up
  the tool hashes its own files and checks the signature; a changed, unsigned or forged copy shows
  a red *Unofficial copy* strip on every screen, and Settings names the changed files. To publish
  a build, sign it last: `node .qa-build-tools/sign-integrity.mjs <integrity-signing-key.pem>`
  (the key never goes in this folder; the tool folder is left out of the zip).
* The Connect Copilot test no longer **sticks at 95%** when Copilot draws the whole answer at once
  under a toolbar of screen-reader labels, and the test message is no longer **typed twice**.
* **Agent Cases is there from the start**, as in the analyser: the Agent Cases report is in
  Current View on first start, and **Sync From Salesforce** opens and reads it when no case list
  is open. Saved lists can now be **Salesforce reports** as well as list views — paste a
  `/lightning/r/Report/00O…/view` link into *Add a Salesforce list view*. The report is read by
  the analyser's v9.5.4 report reader (content.js).
* **Display size** (zoom) in Settings, 70%–130%, plus Ctrl + / Ctrl − / Ctrl 0.
* The ⚙ tab is gone — **⋮ → Settings** is where Settings lives, as in the analyser.
* The **GitHub update check is removed** — button, dot, dialog, schedule and the `api.github.com`
  permission. A new build arrives by replacing the folder; your reviews are kept (see below).
* Fixes found on the way: a short multi-paragraph Copilot answer was cut to its first line (it
  made *Test the case upload* fail); a short answer under a Copy / Regenerate bar could come
  back as "Regenerate"; a message box smaller than expected threw *"material is not defined"*
  instead of re-splitting the message (both in the analyser's v9.5.4 relay too); chat answers could print their opening twice; "78/100" was
  read as the band "100"; a failed write-up showed a score instead of **!**; reviewed cases said
  "not read" in the chat picker; re-running a case after signing in kept failing; column
  headings sat 6px off their columns; the Reviews filter was squeezed to a few letters.

---

## What it does

Given a Salesforce case list, it goes through the selected cases **one at a time**, opening each
in a background window and reading everything on it — emails, Chatter posts, internal notes,
call logs and replies, with their dates and times. Then, for each case:

**It measures** (arithmetic, in JavaScript, before any AI sees the case):

| Measurement | Rule |
| --- | --- |
| First response time | From the moment the case was **transferred to its owner** to the first thing that owner sent **to the customer**. Target **2 hours**. The hours a case spent in a queue before anybody was given it are not the owner's, so they are not counted; if no transfer is readable in the feed, the case opening is used instead and the review says so. Internal notes and call logs are excluded — neither is a reply to anybody. |
| Silence gaps | Any stretch over **3 days** between posts, with the side that was holding the case named. |
| Still waiting on us | The newest message is the customer's and it has been over **2 days**. |
| Customer chasing | The customer wrote again with no reply from us in between. |
| Meeting notes | Every meeting or session found, and whether a call log or a written-up post followed it within **24 hours**. A call log is its own note. |
| Reply times | The median time from a customer message to our next reply. |
| 30/60/90 milestone | Derived from the case age. Never guessed. |

**Then it judges** (this is what the AI is for) — whether the answers were any good, whether
the resolution note is worth reading, what went well, what should change, and **which training
the agent needs**.

### Why the split matters

A model asked "was the first response inside two hours" has to parse forty timestamps — some
of them relative ("3h ago") — subtract two of them and compare against a threshold. It will
answer confidently either way. When the output ends up on somebody's coaching record, a
confident wrong number is worse than no number.

So every fact that **can** be computed **is** computed, the model is told those facts as
givens and forbidden to re-derive them, and what is left for it is the part that genuinely
needs someone to read the case.

On screen the two halves look different: the measured findings are a ticked/crossed list at
the top of every review card, the written judgement is prose below it.

---

## Installing it

**For the team, install from the shared OneDrive folder** — then every release reaches you by
itself. The step-by-step page is **Install_QA_Tool.html**; in short:

1. Open the shared **QA Tool** folder in OneDrive on the web and press **Add shortcut to My
   files**. It appears in File Explorer under *OneDrive* (the owner's name, then *QA Tool*).
2. Right-click it → **Always keep on this device**, so every file is on the laptop.
3. Chrome → `chrome://extensions` → turn on **Developer mode** (top right) → **Load unpacked**
   → choose that **QA Tool** folder (the one with `manifest.json` in it).
4. Pin the teal **QA** icon to the toolbar and click it to open the side panel.

Installing from a copied folder or a zip still works — it just does not update itself.

Then, once:

* The **Connect Copilot** dialog opens by itself. Press **Grant access to Copilot** and allow
  it when Chrome asks — it asks for `m365.cloud.microsoft` and `copilot.cloud.microsoft`
  together, because Microsoft moves the chat from one to the other. The connection is tested as
  soon as it is allowed. (Missed it? **⋮ → Settings → The AI → Grant access to Copilot**.)
  Reviews are written through a Copilot tab the tool drives itself, so nothing leaves the
  browser for a service you are not already signed in to.
* **⋮ → Settings → Test the case upload** once, to prove a whole case file reaches Copilot and
  is read to its end.

---

## Using it

### 1. Get the cases in

Open the Salesforce case **list view** you review from (Cases → whichever queue) and press
**Sync From Salesforce** (or the **↻** beside it — the same sync in one glyph). The tool
refreshes the list first — a Lightning list view is a snapshot of when it loaded and does not
re-query because time has passed — then scrolls it to the end and reads every row. The count
and the time of the last sync are in the button's tooltip.

After the first sync it remembers the list, so later syncs work from any tab: if the list is
open elsewhere it brings it to the front, and if it is closed it reopens it.

**+ Add Case** opens a menu of three ways in, the analyser's:

* **📋 From the Salesforce tab** — adds the case open in your active browser tab.
* **🔗 Add Case URL** — paste one case's link. A case added by hand is kept when the list is
  synced again, even though no list view holds it.
* **📑 Add a List of Cases** — paste a `/lightning/o/Case/list?filterName=…` address and name
  it. It is kept under **Current View** as a chip: press it to open that view in Salesforce
  **and** sync the queue from it in one go. Right-click a chip to **rename** or **forget** it;
  the chip for the queue on screen is marked.

### 2. Pick what to review

* **Select** turns every row's tick-box on — a click on a row then ticks it instead of opening
  it. **Select all** ticks everything on screen (or **Ctrl+A**), the **bin** takes the ticked
  cases off the list (local only), and **Cancel** or **Esc** stops selecting. Pressing **QA** with
  nothing ticked starts selecting for you.
* **The filter box** matches the case number, subject, account, contact, JIRA, status and
  owner. **Commas give alternatives** — `Imran, Ayse` is everything those two own, and a name
  that owns cases in the queue is matched against the owner only, as whole words. This is the
  by-owner workflow: filter to the agent, Select → Select all.
* **The chips** narrow the list: the entitlement tiers, **JIRA** (cases with a defect raised),
  **★ Focus** (waiting on SOTI, new, or a red activity dot), and this tool's own —
  **30-day / 60-day / 90-day**, **Needs 30/60/90**, **Not yet QA'd**, **Already QA'd**.
* **▸** on a row shows what the case is about, where its QA stands, and **QA this case**,
  **Open review** and **💬 Chat**. Right-click a row for the same, plus copy and remove.
* **⚙ → Columns** (or right-click the headings) chooses what each row shows; drag a heading's
  right edge to resize it.

Every row that has reached a milestone carries a coloured flag — amber at 30, orange at 60,
red at 90 — so the cases due a management review are findable without reading a single age.

### 3. Run it

Both buttons are on the bar just above the cases:

* **QA _n_ cases** — the full quality review, one row of the QA sheet per case.
* **30/60/90** — the management-review write-up for aging cases. It warns first if any of the
  ticked cases are under 30 days old.

Copilot is checked **before** anything is read: if Chrome has not given the tool access, the
Connect Copilot dialog opens instead and starts the same run once Copilot has answered. If the
relay is refused part-way — access withdrawn, or Microsoft asking you to sign in — the run
**stops at that case** rather than failing every case after it, says which of the two it was,
and **Re-run the incomplete ones** on the Reviews tab picks the cases up again.

**Delete** on the Reviews tab clears the list. It says the number it will take, and it takes
what the filter is showing — "Delete all 27" with no filter on, "Delete these 3" when you
have filtered down to three — so what it does is legible before you press it. Deleting every
review clears the coaching sheet with them, because a coaching row cites reviews by case
number and one left standing would be quoting evidence that no longer exists. Case
conversations and the stored case material are **kept**, so a case can still be discussed
and re-reviewed without reading it again. To clear everything the tool has stored, including
the conversations, use **Clear everything this tool has stored** in the ⋮ menu.

The pill in the title bar shows progress from every tab and has a **Stop** button (the case
being read finishes first). The **Reviews** tab carries a run log saying what was opened, what
came back and what went wrong — so a run that quietly skipped four cases does not look like
one that read them all.

Reading and writing are different kinds of slow, so they run as a pipeline: while case three
is being written up, cases four and five are already loading. Reads run in parallel (set the
number in Settings; two is comfortable on a support laptop); the AI half is strictly one at a
time, because the relay is a single Copilot conversation and two prompts in one message box
would produce an answer belonging to neither case.

### Reading the email chain

The case is read the way the SOTI AI Analyser reads it — the same feed loader, the same
body extraction, the same reply grouping — with two differences that matter for a QA read.

**The tab is painted while the case is scraped.** Salesforce lazy-loads the case feed off
an IntersectionObserver on a sentinel at the foot of the scroller, and an observer only
fires for an element the browser is laying out and painting. A background tab in a
minimized window is neither, so the scroll loop ran its rounds against a page that never
fetched anything, and the read came back with whatever was in the first server-rendered
payload. The reader now borrows the foreground for the scrape and gives it straight back.
Pages still LOAD in parallel; the scrapes queue behind each other, which is the honest
cost of reading the whole case instead of an eighth of it.

**A message whose body will not render is still a message.** Salesforce renders an email
into an `<iframe srcdoc>`, so its text is not reachable as text; the escape hatch is the
`value` attribute on `<emailui-rich-text-output>`, and a collapsed item has neither. But
the timestamp, the author and the direction live in the item HEADER, which is always
there — so the message is kept and counted, flagged as having no readable text, and the
write-up is told it may not quote or characterise what it cannot see. Dropping those items
whole is what produced `read 0 post(s)` on a case made entirely of email.

The run log prints both halves — `read 22 message(s) of 31 feed entries, 22 dated, 3 with
no readable text` — because a forty-message case that lost thirty-five of them and a
genuine five-message case are opposite conclusions that used to look identical. A feed
that was still loading when the read stopped says so, in the log and in the write-up, and
the timings are reported as a floor rather than a fact.

### The case goes up as a file

The relay is M365 Copilot driven through its own web page, and a chat box has a character
limit. A case does not: a long email chain with forty replies on it is hundreds of
kilobytes of evidence, and it is exactly the case a QA review most needs to read in full.

So the case material is **attached**, the way the analyser has always attached one. What
goes into the chat box is the instructions, the QA headers, the training list and the role
legend — about eight thousand characters, one message. Everything from `[CASE FACTS]`
down — the facts, the measured findings, the description and the whole transcript — goes
up as `C01725481-case-material.txt` next to it, named after the case so you can recognise
it later in your own OneDrive and clear it out.

This used to be a single lump of text in the chat box, and the cost was paid twice. Big
cases were **cut to fit**: every post clipped at 2,500 characters and the transcript at
120,000, with the transcript honestly declaring itself a sample — so the write-up was
grounded in part of a case and said so. And what survived that was split across numbered
messages, because it still did not fit. On a genuinely large case that was 1.3 MB of
evidence going out as eight messages with 790,000 characters thrown away. The same case
now goes as one message and one file, complete.

**Nothing is clipped on the way into the file.** The per-post limit is gone entirely on
this path — a single email carrying a forty-reply chain is the post most likely to hold the
commitment or the chase an audit turns on, and a post cut at 2,500 characters does not read
as cut, it reads as short. The transcript's own budget is not a second guess either: the
panel reads `attachMaxChars` off the provider — a ceiling that was measured rather than
hoped for — and `attachedSize` in `qa-engine.js` reserves what the facts, the measured
block and the description need out of it, so what is left is the transcript's and the sum
cannot overflow. If a case ever did have to lose something, the cut is made here rather
than by the provider, and it is made at the **oldest** end: the newest half of a QA
transcript is the resolution and where the record stands today, and the early timeline
survives regardless in `[MEASURED FACTS]`, which is computed over the whole case every
time.

**How the split is decided, and why it can no longer break quietly.** `ai-provider.js` cuts
the prompt at the first line opening with a bracketed ALL-CAPS name and uploads everything
from there. That makes the order of the prompt a contract rather than a layout: rules,
headers, training areas and legend first, none of them bracketed; `[CASE FACTS]` and
everything after it is the case. Bracket a heading above that line and the QA sheet's own
schema leaves the message and goes into the file; forget to bracket the first data section
and the whole case stays in the chat box. Both failures are silent, both produce a worse
answer rather than an error — and one of them had already happened.

So the rule is enforced instead of remembered. Every prompt builder returns through
`splitPrompt`, which strips the brackets off any heading in the instructions half that
would move the cut, guarantees the material half opens the data section, and checks its own
work against the very regex `ai-provider.js` uses, warning in the console if the seam is
not where it should be. A heading edited carelessly can no longer change where the case is
sent.

**Every case goes as a file, however small.** `ai-provider.js` has an upload floor —
`attachMinChars`, 8,000 characters — below which it judges a file not worth the round trip.
That number was set for the analyser, whose payload is a log bundle measured in megabytes,
and it is the wrong shape of number for a case audit, because **a support case is prose**.
Measured against real shapes: three messages is 1,900 characters of material, ten is 3,300,
twenty is 5,200, and a busy case with **thirty** messages on it still comes to about 7,200.
Every one of those sits under the floor — so every one of them was typed into the chat box
and no attachment was ever offered. The only cases that cleared 8,000 were the ones
carrying a long quoted email chain, which is why it looked intermittent rather than broken.

The panel therefore drops the floor at boot, the same way it switches the product reference
off: for this tool the case is **always** attached. The cost is a few seconds and one small
`.txt` per case. What it buys is a message that stays the same tiny size whatever the case
is, one place for the model to read evidence from, and no case competing with its own
instructions for room.

**The chat reads the whole case too.** A chat is a review continued by other means —
"justify that score", "what did the customer actually ask on the 3rd" — and both of those
are answered by the post a clipped copy is most likely to have dropped. The full transcript
is written to a key of its own when the case is read (not onto the case index, which
`chrome.storage` rewrites whole on every save, so caching one case would mean rewriting
eighty), and it is loaded the moment before a question is sent. A case read by an older
build, or one whose document has aged out, falls back to the index copy and the chat works
exactly as it did.

**Every review records how it travelled.** A write-up built on the whole case and one built
on a transcript that was trimmed by six hundred thousand characters arrive looking
identical — same headers, same confident prose, same score. So each ask records what
`ai-provider.js` did with the prompt and what the relay reported back, and the card says it
at the bottom: *the case went to Copilot as C01725481-case-material.txt — 412,830
characters, complete*. The run log stays quiet unless something was actually lost, because
a reassurance printed on all thirty cases of a run is one nobody reads. The case this
catches is the important one: the site had no usable upload control, the relay quietly fell
back to typing the case as text, and the answer came back looking fine.

**Test it before a run depends on it.** Settings → **Test the case upload** sends a made-up
case with three markers hidden at its start, its middle and its end, and asks Copilot to
read all three back. Getting the last one proves the file arrived, was read, and was read
to its end — which is the one thing a working relay test cannot tell you.

**Nothing rides along with it.** The analyser uploads its product reference — ports,
services, log sources — beside the case, because it answers technical questions out of
them. This tool ships no knowledge folder and asks a different question: how a record was
handled. One file goes up, and it is the case.

### When the relay will not answer

The AI half is a web page being driven, not an API, and it fails the way a web page does:
the composer would not take a message that size, the conversation had not gone idle before
the next part was typed, the answer took longer than the timeout, the site rate-limited a
run of thirty cases. Those are transient or size-related, and the tool used to catch the
first one and file the case as failed without ever asking again.

Every write-up now gets up to **five asks**. The first two send the whole case, seconds
apart, because most of these come good on the second go. The rest send less of it each
time — the transcript is the only part big enough to matter — because a review of most of a
case beats no review at all. A shortened transcript says so **at the top**, before the
evidence rather than after it, so the write-up cannot conclude that something is absent
from the case when it was only trimmed from the request. The measured facts are computed
over the whole case either way and stay complete.

A **refusal** stops after three: shrinking the case does nothing for a guardrail declining
the request, and the remaining rungs would be two more minutes spent proving the same
point. Coaching rows climb the same ladder, without the shrinking — there is no transcript
in one, only a handful of reviews.

Failures are named rather than lumped together. A relay that never answered, a relay that
declined, and a relay that answered with something that was not a review want three
different responses from you, and only the first is worth simply running again. The log
prints the actual error too: it used to chop it at the first full stop, which in
`m365.cloud.microsoft never showed the message back…` is inside the hostname — so every
relay failure, whatever it was, arrived as `write-up FAILED — m365.`

**A case that goes wrong costs that case, not the run.** A page that would not load is tried
once more before it is given up on; a case whose feed comes back in a shape the reader did not
expect is reviewed without the part it could not read; and anything that fails outright is
written into the reviews list as an incomplete review with the reason on it, so the rest of
the queue carries on. Nothing you ticked can disappear out of a run without leaving a row.

### The names do not go out

Every name in a case — the agent's, the customer's, anyone who wrote on it — is replaced with
a role label before the case is sent, and the labels are swapped back for the real names in
the answer. The review you read is word for word what it would have been; only the wire is
anonymous.

That is a privacy improvement worth having on its own, and it is also what makes the review
arrive at all. **M365 Copilot refuses outright to assess an identifiable employee**, and a QA
review is exactly that. The refusal comes back over the relay looking like a perfectly normal
answer — HTTP 200, prose in the body, no error anywhere — so before this it was stored as a
review, and turned up on the QA sheet as a row carrying a case number, a date and an agent —
all three written from the tool's own record — with the other ten columns empty. It looked
reviewed.

Now:

* the case goes out under role labels, which is usually enough on its own;
* an answer that still declines, or that comes back without the sheet's headers in it, is
  **asked once more** with the framing spelled out rather than left to be inferred;
* if it still is not a review, it is stored as an **incomplete** one — with what the relay
  actually said on the card, a **Read and write it up again** button, and **no row on the QA
  sheet**.

It can be switched off in Settings, to compare. Expect refusals when it is off.

### 4. Ask about a case

Every case gets a **chat of its own** — the speech bubble at the end of its row, the **Ask
about this case** button on its review card, or the **Chat** tab.

A review answers the questions the sheet asks and then stops. The next question is always the
same one — *why?*, *show me where*, *what should they actually have done* — and that is what
this is for. The chat is grounded in exactly what the review was grounded in: the same case
facts, the same measured findings, the review itself, and the whole transcript oldest-first.
So you can say "justify that score against the case" and get an answer with dates in it, and
"the case does not say" is a real answer rather than a shrug.

Answers stream in as they are written. Suggested questions appear under a fresh chat and are
chosen from what was *measured* — a case with an undocumented meeting offers the meeting
question; a case without one does not.

The whole turn goes out under the same role labels the review used, including the question you
typed — one real name in the last message is enough for the relay to decline the turn — and
the answer is named again as it streams, so you never see a label. A question that is declined
anyway is asked once more with the framing spelled out; if that is declined too, the chat says
so and says what to ask instead, rather than leaving an apology sitting there looking like an
answer.

Each conversation is kept per case, so coming back to a case days later finds it where you
left it. A strip at the top always says what the answers stand on and how old it is; a case
that has never been read says so plainly and offers to read it in one press.

### Every reviewed case carries a score

The write-up is asked for a number out of 100 and a band, and what it writes is what is
used. When it does not write one — or writes it somewhere the headers do not cover — the
tool looks through the rest of the answer for it, and failing that **works one out from the
measured facts** using the rubric the prompt itself states.

A worked-out score is marked with a small dot on the review card, and hovering it says what
it was based on. It is a calculation, not a second opinion on the prose, and you should
always be able to tell which you are looking at. What could not be measured is never held
against the case: an unreadable feed caps the score rather than reducing it.

`reviewed, but the write-up carried no score` is gone from the run log, because it can no
longer happen.

### 5. The sheets

**QA Sheet** is the team's own spreadsheet, column for column and in its order:

> Case Number · Date Reviewed · Closure Check · Internal Resolution Note Quality ·
> Case Handling Notes · JIRA / Other Agent Follow-up · KB Articles · Positive(s) ·
> Improvement Point(s) · Final Comment

with three **additional** columns after them — **Agent**, **QA Score**, **Training Needed** —
so pasting into the existing spreadsheet lines up and the extras spill into the empty columns
to the right rather than pushing everything one across.

**Copy for Excel** puts it on the clipboard tab-separated; **Download CSV** writes a file.

**Coaching** is the summary template — Agent · Main Pattern Observed · Coaching Pointer /
SMART Goal · Due Date · Notes — with one row per agent on the team list. Press **Build from
reviews** and each agent's row is written from *their reviews*, not from their cases again, so
it can only ever say what the reviews said. Above the grid, a counted strip shows how many
cases each agent had, their average score and their most frequent training area — which is the
check on the written row beside it.

---

## New versions

**Installed from the shared OneDrive folder, a new version arrives by itself** — the SOTI AI
Analyser's (Global 1.3.2) mechanism, in `updater.js`. Nothing is asked of the network: the tool
only ever reads its own folder, which OneDrive keeps in step with the shared one.

* Once a minute (and when the browser starts) the background looks at the folder's
  `manifest.json`. While its version is the one running, that is all it reads.
* When the version differs, the release is applied **only if it is complete and genuine**:
  `integrity.json` must carry a valid signature from the owner's key, be the one made for that
  version, and every file it lists must match. A folder OneDrive is still part-way through
  filling is left alone and looked at again in half a minute. A release signed by anyone else
  is never applied.
* **Panel closed** → the tool restarts onto the new version straight away.
  **Panel open** → a blue bar says *Version X is ready* with **Restart now**. **×** puts it off;
  it then restarts by itself when the panel is closed, or has been out of sight for ten minutes
  with nothing running. A QA run, a sync, a chat answer or the coaching build holds the restart
  off, and **Restart now** asks first if one is going.
* After the restart, the panel says *Updated to version X (from Y)*. Every review, chat and
  setting is kept — they live in `chrome.storage`, which a restart does not touch.

**To publish a release:** bump `"version"` in `manifest.json`, re-sign the folder (so
`integrity.json` is made for the new version and lists every code file — `updater.js`
included), then copy the files into the shared OneDrive folder. Put `integrity.json` in last
if you can; the tool waits for it either way.

Installed from a zip or a copied folder instead, a new build is copied over the old one and
**Reload** pressed on `chrome://extensions`, as before.

### Your reviews survive a new version

`manifest.json` carries a `key`, which **pins the extension ID**. Without one, Chrome derives
the ID of an unpacked extension from its *folder path* — and this folder is named for its
version, so every release would rename it, change the ID, and hand the new build an empty
`chrome.storage`: every review, chat and setting gone, with nothing on screen saying why.

The private half of that key is `qa-tool-signing-key.pem`, kept **outside this folder** beside
the analyser's, and git-ignored in both places. It is only needed to publish a signed `.crx`;
losing it costs you that and nothing else — the ID comes from the public half, which is in the
manifest and is meant to be there.

**Back up anyway** before rebuilding a Chrome profile or moving to another machine:
**⋮ → Settings → Your data → Back up my data**. It writes every key the extension holds to a
JSON file, read with `null` rather than a named list — a backup that silently omits the chats
is worse than no backup, because it is trusted. **Restore from a backup** reads one back in;
it is additive — it writes the keys the file holds and leaves everything else alone — and the
panel reloads afterwards.

---

## The repository

This folder **is** the repository — extension files at the root, so a zip of `main` unzips to
something you can copy straight over an install.

### Cutting a release

```bash
# bump "version" in manifest.json first — that is the number Chrome reads
git add -A
git commit -m "QA Tool v1.1.0 — <what changed>"
git push
```

Then re-sign it, and copy the files into the shared OneDrive folder — every install made from
that folder picks the release up by itself (see [New versions](#new-versions)). For anyone
installed from a zip, zip the folder as `QA Tool v<version>` and hand that out too.

### Line endings

`.gitattributes` forces LF in the working tree as well as in the repository. Git for Windows
sets `core.autocrlf=true` at the system level, and without that file a clone rewrites every
source file to CRLF while the repository stores LF — which makes any whole-file touch produce
a 40,000-line diff that buries the two lines somebody meant.

---

## Which training the agent needs

The model picks from a **closed list**, never free text:

Troubleshooting methodology · Networking · Product knowledge · Log analysis ·
Customer communication · Case documentation · Meeting and call handling ·
Escalation and JIRA process · SLA and time management · Knowledge base usage ·
Closure process and CSAT

The list is closed on purpose. "Needs to improve troubleshooting", "troubleshooting
methodology" and "better fault-finding" are one gap in three phrasings, and three phrasings
cannot be counted — so the coaching summary could never say "four of Imran's six cases came
back with the same finding", which is the only thing that makes the summary worth writing.

Anything the model names that is not on the list is **kept** and marked with a dashed outline
rather than dropped: an uncategorised training need is still a training need.

---

### How the first response is measured

**The two hours run from the moment the case was transferred to its current owner** — the
`Case Owner: HQ - Support Queue to <name>` entry Salesforce writes into the feed — to the
first thing that went out to the customer. Not from when the case was opened. A case that
sat in a queue for three weeks before anybody was given it is not three weeks of its
owner's silence, and reporting it as such puts a failure on the record of somebody who
answered in thirty-eight minutes.

Internal notes and call logs are not first responses: one never left SOTI, and the other is
a record of a conversation rather than a reply to a message. Both still count as activity
and both appear in the gap arithmetic.

Finding the transfer takes three steps, because Salesforce hides it three ways.

1. **A collapsed feed item has no body in the DOM at all** — Lightning renders it on
   expand — and Salesforce's own "Expand all visible posts" button opens posts only. It
   does not touch the "Case updated" entry the owner change lives in. The reader opens
   every item that is still shut before it reads anything.
2. **Changes made in one moment are clumped** into a single entry showing a couple of rows,
   with the rest behind a **Show All Updates** link. On one case that left `Status` and
   `Temporary Case Owner` on screen and both `Case Owner` rows out of reach, so the tool
   reported a case that had been transferred as one that never was. The reader presses that
   link too.
3. **A clump can carry a chain of handovers** — `Kartikay Kapil to Saksham Gupta` and
   `Saksham Gupta to Ayodeji Augustine` under one timestamp. All of them are collected, and
   the one that lands on the current owner is the one the clock starts at. Where the owner
   field and the feed spell the name differently, a transfer whose destination is another
   transfer's origin at the same instant is discarded: it is a step, not an arrival.

**Temporary Case Owner is never a handover.** A temporary owner is cover while somebody is
away; the target belongs to the owner of record, and starting the clock at a stand-in's
name measures the wrong person's silence.

A case whose transfer still will not open says so, rather than being reported as a case
that was never transferred.

**When the transfer cannot be read, the case is neither a pass nor a miss.** The tool
measures from the case opening instead and then applies the only rule that is safe in that
direction:

| Measured from the case opening | Verdict |
| --- | --- |
| Inside the target | **Pass.** The handover can only have come later, so the real gap is smaller still. |
| Outside the target | **Not assessable.** The handover may have been minutes before the reply. |
| Nothing ever sent to the customer | **Miss.** No start time rescues a case nobody answered. |

A case in the middle row is reported with the duration, a warning saying why it cannot be
counted, and an explicit instruction to the write-up not to call it late.

---

## Settings

| Setting | Default | What it changes |
| --- | --- | --- |
| First response target | 2 hours | The FRT every case is measured against, from the handover |
| Flag silence longer than | 3 days | Clears a weekend on purpose — a rule that flags every case is switched off within a week |
| Meeting written up within | 24 hours | The grace period before a meeting counts as undocumented |
| Flag "waiting on us" after | 2 days | How long the newest customer message may sit unanswered |
| Cases read at the same time | 2 | Every case being read is a whole Salesforce page in memory |
| Send cases with the names removed | on | Role labels out, real names back in the answer. Turning it off usually means Copilot refuses the review — see [The names do not go out](#the-names-do-not-go-out) |
| The team | the nine names on the coaching sheet | Decides the sheet's order and who appears with no cases yet — **not** who may be reviewed |
| Display size | 100% | The whole panel smaller or larger, 70%–130% — text, buttons and case columns together. Applied at once and kept on this computer; Ctrl + / Ctrl − / Ctrl 0 work anywhere in the panel |

An agent who turns up in the queue without being on the team list is still reviewed and still
gets a coaching row.

---

## What is in this folder

| File | What it is |
| --- | --- |
| `QA_Tool.html` | The side panel |
| `qa-panel.js` | The screen, the run, and the per-case chat |
| `qa-engine.js` | The measurement, the prompts, and reading the answers back. No DOM, no `chrome.*` — the rules are checkable without a browser |
| `case-reader.js` | The background reader window: one window, one tab per case |
| `content.js` | The Salesforce reader. **The SOTI AI Analyser's, carried over whole**, with a QA appendix at the end that returns the feed as records rather than as prose |
| `reader-wake.js` | Keeps an occluded reader tab rendering. The analyser's, unchanged |
| `ai-provider.js` | The Copilot relay. The analyser's v9.5.4, with a few QA Tool additions, each marked `(QA Tool addition)` |
| `copilot-bridge.js` | Injected into the relay tab. The analyser's v9.5.4, with one QA Tool addition, marked the same way |
| `styles.css` | The analyser's v9.5.4 stylesheet, unchanged, so the two tools look like siblings |
| `qa-styles.css` | Only what QA adds — the QA button, the run pill, the chat, the sheets, the owner dropdown, the review folders, the update bar |
| `integrity.json` | The owner's signature over every code file — what *✓ Verified original* checks, and what decides whether the shared folder holds a genuine release |
| `release.json` | The rest of the release (the icons), byte for byte, so a half-synced folder is never loaded. Covered by the signature |
| `Install_QA_Tool.html` | The install guide for the team — sent to people, not put in the shared folder: a file changed there after signing marks every copy as modified. Put the shared folder's link in it first (search it for `PASTE-THE-QA-TOOL-FOLDER-LINK-HERE`) |
| `background.js` | Opens the side panel, keeps a clock running for the relay, and looks for a new release in the shared folder |
| `updater.js` | Decides when the folder holds a complete, signed new release, and restarts onto it. The analyser's (Global 1.3.2) |
| `backup.js` | Back up and restore everything the tool stores |
| `display-size.js` | Settings → Display size, applied before the first paint |
| `icons/` | The toolbar mark: a teal "QA" badge, drawn so it is not mistaken for the analyser's indigo hexagon at 16px |

### Keeping it in step with the analyser

`content.js`, `reader-wake.js` and `styles.css` are verbatim copies, and `ai-provider.js` and
`copilot-bridge.js` nearly so. When the analyser fixes something in one of them, replace the
file here — then:

* in `ai-provider.js` and `copilot-bridge.js`, search the old copy for `QA Tool addition` and
  carry each one across (and replace the first line's notice), unless the analyser has made the
  same fix itself;
* in `content.js`, everything after the `QA TOOL — THE STRUCTURED FEED READ` banner is this
  tool's and has to be re-appended.

The knowledge corpus and the OCR libraries are deliberately **not** copied: QA is about how a
case was handled, not about what the product does, so ~30 MB of product documentation would
cost transfer time on every request and answer no question this tool asks.

---

## Things worth knowing

**The reader window will sometimes come to the front.** A window Chrome considers fully
covered is not painted, and a Lightning record page that is not painted never finishes
mounting. There is no API for "composite this window without raising it". So for the few
seconds a stubborn case takes to load, the reader window is the front window, and the focus is
handed straight back afterwards. Most cases never trigger it.

**A case whose feed could not be read says so.** It is not reported as a clean case. The review
card carries the reason, and the timing findings are withheld rather than guessed — a case
whose posts could not be attributed to a side gets `first response: could not be measured`, not
`met`.

**A failed write-up still keeps the measurement.** The expensive half of a review is opening
the case and reading its feed to the end; if the relay fails afterwards, the findings are saved
with the error and re-running that one case is one button on its review card.

**A chat is only as current as the last read.** The material is captured when the case is read, not when you ask - so on a case that has moved on since, press *Read it again* in the chat before you trust an answer about what is happening now.

**Re-reviewing a case replaces its review.** Two reviews of one case would each claim to be the
QA record for it and the sheet would carry the case twice with different scores.

---

## One assumption to check

The third column of the QA sheet is headed **Closure Check** in this build. The sub-heading in
the original spreadsheet was not fully legible in the copy this was built from — if it reads
differently on the real sheet, the column name lives in one place, `SHEET_COLUMNS` at the top
of the sheet section in `qa-panel.js`, and the matching header in `buildQaPrompt` in
`qa-engine.js`. Both must be changed together: the prompt's headers *are* the schema the answer
is parsed back out of.
