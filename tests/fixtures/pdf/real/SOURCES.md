# Real PDF fixtures: sources, provenance and licence basis

Eleven real PDFs of United States government works (public domain), about 20 MB in total, used by:

- `real.integration.test.ts` (vitest, always on, about 10 s): every file through the reader's own open
  path (`openSession`: header check, SHA-256 identity, pdf.js, sampled text status, document row), with
  page count, text status, outline and page geometry asserted against the table below;
- `tests/e2e/pdf-real.spec.ts` (Playwright, real Chromium, real built extension), for the files of
  under 100 pages: open through the file chooser, draw page 1, outline and page navigation, search; for
  the three smallest text files and the Korean one, select a passage, save a highlight, reload, choose
  the file again and find the highlight on the same words; a real mouse drag in a two-column article,
  a selection across a page boundary, a save bar that stays reachable when the selection is off
  screen, and OCR of one scanned page of each scan (a highlight on recognised text where it reads);
- `tests/e2e/pdf-real-memory.spec.ts`: windowing and heap while every page of the documents of 50 or
  more pages is brought on screen, the 192-page guideline included (numbers: `docs/PERF_REVIEW.md`,
  addendum of 2026-10-12).

The owner approved this download in the chat on 2026-10-11 (about ten public-domain PDFs from US
government sources, under 25 MB in total). The files were fetched once, with `curl --location --fail`,
into a new empty directory outside the repository; every file begins with `%PDF-`; nothing was executed
from them (they were only parsed with pdf.js, and none has document JavaScript, attachments, XFA or
encryption). The tests read the committed bytes: **nothing here touches the network at test time.**

## Manifest (read by the tests; do not edit by hand)

Columns are what the reader reports, measured through the product's own loader (not typed from a viewer):
`Text` is the verdict of the reader's text check (`text`, `scanned` = no selectable text,
`partial` = some pages have none), `Outline` the entries of the flattened bookmark list,
`Landscape` the pages that are displayed wider than high after `/Rotate`, `Rotated` the pages that carry
a non-zero `/Rotate`.

<!-- real-pdf-manifest:begin -->

| File                                     | Pages | Bytes   | SHA-256                                                          | Text    | Outline | Landscape | Rotated |
| ---------------------------------------- | ----- | ------- | ---------------------------------------------------------------- | ------- | ------- | --------- | ------- |
| `cdc-sti-guidelines-2021.pdf`            | 192   | 2656906 | 30f100ad234a2b794232488a380ff75544c557f35bf2b25681a9281b6575bab4 | text    | 22      | 0         | 0       |
| `cdc-mmwr-vaccination-coverage-2023.pdf` | 8     | 461992  | aa0158646a13d2d9419839b0677344b79e43981a3fff4d04ad6ef3eb013b69fd | text    | 1       | 0         | 0       |
| `nist-tn1297-uncertainty-1994.pdf`       | 25    | 435960  | f2c8e6026d5589a63d492f192b72cd905f554b477a6049532256170aec477e92 | text    | 0       | 0         | 0       |
| `nist-sp800-63-3-digital-identity.pdf`   | 76    | 1599268 | 915bb812cb705918461e642e84141c6ca2adc2ca0106e1d88f3884c61f07110a | text    | 46      | 0         | 0       |
| `nist-cswp29-csf-2-0.pdf`                | 32    | 1518858 | 3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c | text    | 12      | 0         | 0       |
| `naca-sr256-ground-speed-1943.pdf`       | 33    | 5250280 | 0b34b5a8cd4cdc3926e9f124d84f949c428ce196c1a91e85f35450c87e3c455b | partial | 0       | 11        | 22      |
| `cdc-child-immunization-schedule-2025.pdf` | 18  | 491592  | 96159043a4ebc04444c349704a783b4d5a76ec96843ed4e64876d5317bb2a1dd | text    | 0       | 18        | 0       |
| `naca-tr1135-compressible-flow-1953.pdf` | 70    | 6759928 | 3d99551f762503583e3066e6d8a87b5be03e8ec75f1536002635e1c40f218479 | text    | 0       | 0         | 0       |
| `cdc-covid-sick-korean-2020.pdf`         | 2     | 555297  | 7256b8788e812fe9eb7b1e002ba80b2ff80aae33b049226fc1711b18075cfb0e | text    | 0       | 0         | 0       |
| `cdc-covid-communities-chinese-2020.pdf` | 1     | 905876  | b00d4a4c33cba611955c99505a7b64931886923f3f36f6aab75aa86a0230df0e | text    | 0       | 0         | 0       |
| `nasa-msfc-60k-combustion-testbed-2000.pdf` | 3  | 82122   | ec6ad03420070712dcd563273a58a9b5af79541b25b1c65de9f9664292d6e69c | scanned | 0       | 0         | 0       |

<!-- real-pdf-manifest:end -->

Total: 20,718,079 bytes (19.8 MiB).

## Provenance and licence basis

Retrieved 2026-10-11 (`nasa-msfc-60k-combustion-testbed-2000.pdf`: 2026-10-12). The URL is exactly the
address the bytes came from (no redirect changed it).
"Basis" is why the file may be committed: 17 U.S.C. § 105 (a work of the United States government is not
protected by copyright in the United States) plus the statement that was checked, with where it was seen.

| File | Document | Exact URL | Basis |
| ---- | -------- | --------- | ----- |
| `cdc-sti-guidelines-2021.pdf` | CDC, _Sexually Transmitted Infections Treatment Guidelines, 2021_, MMWR Recommendations and Reports 70(4), 23 July 2021 | https://www.cdc.gov/mmwr/volumes/70/rr/pdfs/rr7004a1-H.pdf | In the PDF itself (page 192): "All material in the MMWR Series is in the public domain and may be used and reprinted without permission; citation as to source, however, is appreciated." |
| `cdc-mmwr-vaccination-coverage-2023.pdf` | CDC, MMWR Weekly 72(1), 6 January 2023, "Racial and Ethnic Differences in COVID-19 Vaccination Coverage Among Children and Adolescents Aged 5-17 Years and Parental Intent to Vaccinate Their Children" | https://www.cdc.gov/mmwr/volumes/72/wr/pdfs/mm7201a1-H.pdf | Same MMWR Series statement as above (series-wide; this weekly extract does not repeat it) and CDC "Use of Agency Materials" (https://www.cdc.gov/other/agencymaterials.html): most CDC content is in the public domain. No copyright, permission or courtesy line in the text. |
| `nist-tn1297-uncertainty-1994.pdf` | NIST Technical Note 1297, 1994 Edition, _Guidelines for Evaluating and Expressing the Uncertainty of NIST Measurement Results_, B. N. Taylor and C. E. Kuyatt (US GPO, 1994) | https://nvlpubs.nist.gov/nistpubs/Legacy/TN/nbstechnicalnote1297.pdf | NIST employees as authors; NIST policy (https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications): "works of NIST employees are not subject to copyright protection in the United States." |
| `nist-sp800-63-3-digital-identity.pdf` | NIST Special Publication 800-63-3, _Digital Identity Guidelines_, June 2017 (the file carries NIST's 2025 "withdrawn" cover page) | https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-63-3.pdf | In the PDF (page 4): "This publication may be used by nongovernmental organizations on a voluntary basis and is not subject to copyright in the United States. Attribution would, however, be appreciated by NIST." |
| `nist-cswp29-csf-2-0.pdf` | NIST CSWP 29, _The NIST Cybersecurity Framework (CSF) 2.0_, 26 February 2024 | https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf | NIST technical series publication; same NIST policy page as above; the PDF's last page points to "NIST Technical Series Policies: Copyright, Use, and Licensing Statements". |
| `naca-sr256-ground-speed-1943.pdf` | NACA Special Report / ACR 256, _NACA Radio Ground-Speed System for Aircraft_, C. E. Hastings, 1943 (declassified scan) | https://ntrs.nasa.gov/api/citations/20090016313/downloads/20090016313.pdf | NASA NTRS record 20090016313: copyright determination `GOV_PUBLIC_USE_PERMITTED`, `containsThirdPartyMaterial: false`, distribution `PUBLIC`; NACA was a federal agency. |
| `cdc-child-immunization-schedule-2025.pdf` | CDC, _Recommended Child and Adolescent Immunization Schedule for ages 18 years or younger, United States, 2025_ | https://www.cdc.gov/vaccines/hcp/imz-schedules/downloads/child/0-18yrs-child-combined-schedule.pdf (a "current edition" address: CDC will replace the content; the committed bytes are the 2025 edition retrieved on the date above) | CDC "Use of Agency Materials" (as above); CDC Stacks lists the preceding edition (https://stacks.cdc.gov/view/cdc/136154) as "Public Domain". No third-party line in the text. |
| `naca-tr1135-compressible-flow-1953.pdf` | NACA Report 1135, _Equations, Tables, and Charts for Compressible Flow_, Ames Research Staff, 1953 | https://www.nasa.gov/wp-content/uploads/2023/03/equations-tables-charts-compressibleflow-report-1135.pdf | NASA NTRS record 19930091059 (same report, NACA-TR-1135): `GOV_PUBLIC_USE_PERMITTED`, `containsThirdPartyMaterial: false`, distribution `PUBLIC`. |
| `cdc-covid-sick-korean-2020.pdf` | CDC fact sheet CS 316120-D, "Prevent the spread of COVID-19 if you are sick" [Korean], 25 June 2020 | https://stacks.cdc.gov/view/cdc/94929/cdc_94929_DS1.pdf | CDC Stacks record 94929: "Public Domain", corporate author Centers for Disease Control and Prevention. |
| `cdc-covid-communities-chinese-2020.pdf` | CDC poster, "CDC protects and prepares communities" [Chinese, Simplified], 18 March 2020 | https://stacks.cdc.gov/view/cdc/86059/cdc_86059_DS1.pdf | CDC Stacks record 86059: "Public Domain", corporate author Centers for Disease Control and Prevention. |
| `nasa-msfc-60k-combustion-testbed-2000.pdf` | NASA Marshall Space Flight Center, _60K Combustion Devices Testbed_, Space Transportation Technology Workshop: Propulsion Research and Technology, 23 January 2000 (3 scanned pages, no text layer) | https://ntrs.nasa.gov/api/citations/20010071162/downloads/20010071162.pdf | NASA NTRS record 20010071162: `GOV_PUBLIC_USE_PERMITTED`, `containsThirdPartyMaterial: false`, distribution `PUBLIC`. The record lists no author affiliations; the determination is NASA's. |

### Third-party content check

Every page of every committed file was read for text with pdf.js and searched (case-insensitive) for
`copyright`, `©`, `(c) <year>`, `all rights reserved`, `reprinted with permission`, `used with
permission`, `permission of`, `courtesy of`, `licensed under` and `creative commons`. Scanned pages
have no text to search (their NTRS records say no third-party material). Result: no hit in any
committed file except the NIST statements about their own licence (SP 800-63-3 page 4: "not subject to
copyright in the United States"; CSWP 29 last page: a pointer to the copyright, use and licensing
policy). The check is a net, not a proof: a credit line printed inside an image would not be found.

## Matrix coverage (TEST_PLAN.md, PDF compatibility matrix)

| # | Matrix item | Real file(s) | Where it is asserted |
| - | ----------- | ------------ | -------------------- |
| 1 | Plain selectable text | `cdc-mmwr-vaccination-coverage-2023` (8 pp), `nist-tn1297-uncertainty-1994` (25 pp), `cdc-covid-sick-korean-2020` | unit: text status and page text; e2e: open, draw, search, and (smallest three plus Korean) save and reopen |
| 2 | Multi-column scientific, tables, equations, superscripts | `cdc-mmwr-vaccination-coverage-2023` (two columns, tables with symbol footnotes), `nist-tn1297-uncertainty-1994` (equations), `naca-tr1135-compressible-flow-1953` (equations, tables, charts), `cdc-sti-guidelines-2021` (tables) | e2e "real layouts": a mouse drag over three lines of one column never picks up the other column |
| 3 | Rotated pages, zoom, landscape | `cdc-child-immunization-schedule-2025` (18 landscape text pages with tables), `naca-sr256-ground-speed-1943` (22 pages with /Rotate 270, 11 displayed landscape) | unit: geometry counts; e2e: draw, navigate, highlight alignment on the rotated page-1 stamp, OCR of a rotated scan |
| 4 | Long (100+ pages) and memory pressure; lazy render | `cdc-sti-guidelines-2021` (192 pp); also `nist-sp800-63-3-digital-identity` (76 pp) and `naca-tr1135-compressible-flow-1953` (70 pp of 8.4-megapixel images) | `pdf-real-memory.spec.ts`: canvases alive at once, heap and DOM growth over a full traversal |
| 5 | Scanned image-only, no extractable text | `nasa-msfc-60k-combustion-testbed-2000` (all pages), `naca-sr256-ground-speed-1943` (partly: one stamp of typed text) | unit: `scanned` / `partial`; e2e: header says so, search says "No matches", OCR recognises one page |
| 6 | Password-protected | none: no public-domain, user-password PDF is available from these sources | synthetic fixtures in `pdf.spec.ts` |
| 7 | Remote public PDF, redirect, content type without .pdf | not by these files (they are read from disk) | `pdf.spec.ts` "web open" with a loopback server |
| 8 | Authenticated content, manual upload fallback | not applicable to public files | `pdf.spec.ts` |
| 9 | Local imported file; close/reopen with stable fingerprint | all | unit: document id equals the file's SHA-256; e2e: reload, choose the file again, the highlight is back on the same words |
| 10 | Selection across line wraps, several spans, page boundary | `cdc-mmwr-vaccination-coverage-2023`, `nist-cswp29-csf-2-0`, `nist-tn1297-uncertainty-1994`, `cdc-child-immunization-schedule-2025`, `cdc-covid-sick-korean-2020` | e2e: two-line passage saved and found again; real mouse drag over three lines of one column; one highlight per page for a range across a boundary |

Other properties and their carriers: embedded outline (bookmarks) in `cdc-sti-guidelines-2021` (22),
`nist-sp800-63-3-digital-identity` (46, nested), `nist-cswp29-csf-2-0` (12); footnotes and hyperlinks in
`nist-cswp29-csf-2-0` (footnotes, 100+ link annotations), `cdc-sti-guidelines-2021` (4,000+ links);
large embedded images in `naca-tr1135-compressible-flow-1953` (70 pages of 2544 x 3300 scans, with an
OCR text layer), `naca-sr256-ground-speed-1943` (3000 x 2552), `nasa-msfc-60k-combustion-testbed-2000`
(2544 x 3300); CJK in `cdc-covid-sick-korean-2020` (Hangul) and `cdc-covid-communities-chinese-2020`
(Simplified Chinese).

## Looked at and not committed

Recorded so the next person does not repeat it.

| Candidate | Why not |
| --------- | ------- |
| `https://www.cdc.gov/growthcharts/data/set1clinical/cj41l017.pdf` | HTTP 404 (address guessed wrong). The chart at `.../cj41c021.pdf` was fetched instead and analysed: one portrait page, no rotation, so it adds nothing over the files above. |
| 9/11 Commission Report, `https://www.govinfo.gov/content/pkg/GPO-911REPORT/pdf/GPO-911REPORT.pdf` (585 pp, 2.5 MB) | Rejected: page 331 carries "© Reuters 2004" photograph credits (third-party material inside a government report). |
| NASA Systems Engineering Handbook SP-2016-6105 Rev 2, `https://www.nasa.gov/wp-content/uploads/2018/09/nasa_systems_engineering_handbook_0.pdf` (297 pp, 3.8 MB; 112 bookmarks) | Left out to follow the rule "skip anything with a copyright notice": NTRS classes it `PUBLIC_USE_PERMITTED`, not a US government work, and page 282 cites a paper with a "© 2009 MIT" line. |
| Apollo 11 flight plan PDFs at `hq.nasa.gov` / `history.nasa.gov` | The old addresses now answer with an HTML landing page (rejected by the `%PDF-` check); the relocated copy is 8.3 MB and the Apollo 11 Mission Report is 11.8 MB, both over the per-file ceiling set here. |
| Project Mercury paper, NTRS 19770022136 (26 pp, fully image-only, 7.3 MB) | Large; the 82 KB MSFC file covers the same case. |
| NTRS 19930080781, 20090016337; NIST legacy circulars 1, 10, 50, 300; NHLBI DASH guide; CDC adult immunization schedule | Fetched and analysed (OCR'd text, a one-line stamp, or nothing new); not needed. |

NTRS answered HTTP 429 (too many requests) after a sweep of its search API for image-only records; the
sweep was stopped and not repeated.

## Replacing a file

Put the new bytes in this folder, run `pnpm exec vitest run tests/fixtures/pdf/real`, and copy what the
failing assertions report (pages, SHA-256, text status, outline, orientation counts) into the manifest.
Keep the total under 25 MB, keep to `https` addresses on `.gov` hosts, and add the licence basis above.
