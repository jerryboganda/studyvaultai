import type { ColorId } from '@shared';

/**
 * Study material for the "student" scenario: what a medical student might have highlighted on
 * reference pages. Each fact is [quote, cloze term]; the term appears verbatim in the quote and
 * becomes the blank of the flashcard made from it. Written for the gallery (not copied text).
 */

export type Fact = readonly [quote: string, cloze: string];

export interface SourceSpec {
  url: string;
  title: string;
  /** Folder path inside the bank, '/'-separated. */
  folder?: string;
  headings: readonly string[];
  facts: readonly Fact[];
}

export interface FolderSpec {
  name: string;
  children?: readonly FolderSpec[];
}

export interface BankSpec {
  name: string;
  color: ColorId;
  icon: string;
  tags: readonly string[];
  folders: readonly FolderSpec[];
  sources: readonly SourceSpec[];
}

const statpearls = (id: string) => `https://www.ncbi.nlm.nih.gov/books/${id}/`;

export const BANKS: readonly BankSpec[] = [
  {
    name: 'Pharmacology',
    color: 'purple',
    icon: '💊',
    tags: ['high-yield', 'adverse-effects', 'pharmacokinetics'],
    folders: [
      { name: 'Autonomic drugs', children: [{ name: 'Adrenergic' }, { name: 'Cholinergic' }] },
      { name: 'Antimicrobials' },
      { name: 'Pharmacokinetics' },
    ],
    sources: [
      {
        url: 'https://en.wikipedia.org/wiki/Beta_blocker',
        title: 'Beta blocker - Wikipedia',
        folder: 'Autonomic drugs/Adrenergic',
        headings: ['Mechanism of action', 'Medical uses', 'Adverse effects', 'Contraindications'],
        facts: [
          [
            'Beta blockers competitively antagonise catecholamines at beta-adrenergic receptors, lowering heart rate, contractility and renin release.',
            'beta-adrenergic receptors',
          ],
          [
            'Cardioselective agents such as metoprolol, atenolol and bisoprolol preferentially block beta-1 receptors at therapeutic doses.',
            'beta-1',
          ],
          [
            'Propranolol is non-selective and lipophilic, which is why it is used for essential tremor and migraine prophylaxis.',
            'Propranolol',
          ],
          [
            'Abrupt withdrawal of a beta blocker can precipitate rebound tachycardia, angina or myocardial infarction; taper over one to two weeks.',
            'rebound tachycardia',
          ],
          [
            'Beta blockers may mask the adrenergic warning signs of hypoglycaemia, such as tremor and palpitations, in patients with diabetes.',
            'hypoglycaemia',
          ],
          [
            'Carvedilol blocks alpha-1 as well as beta receptors, adding vasodilation; it reduces mortality in heart failure with reduced ejection fraction.',
            'alpha-1',
          ],
        ],
      },
      {
        url: statpearls('NBK557789'),
        title: 'Muscarinic Antagonists - StatPearls - NCBI Bookshelf',
        folder: 'Autonomic drugs/Cholinergic',
        headings: ['Indications', 'Mechanism of Action', 'Toxicity'],
        facts: [
          [
            'Atropine blocks muscarinic receptors and is first-line for symptomatic sinus bradycardia.',
            'Atropine',
          ],
          [
            "Anticholinergic toxicity presents as 'hot as a hare, dry as a bone, red as a beet, blind as a bat, mad as a hatter'.",
            'Anticholinergic',
          ],
          [
            'Physostigmine crosses the blood-brain barrier and can reverse central anticholinergic delirium.',
            'Physostigmine',
          ],
          [
            'Organophosphate poisoning causes a cholinergic crisis: miosis, bronchorrhoea, bradycardia, salivation and fasciculations.',
            'miosis',
          ],
          [
            'Pralidoxime regenerates acetylcholinesterase only if given before the enzyme-organophosphate bond ages.',
            'Pralidoxime',
          ],
          [
            'Ipratropium and tiotropium are inhaled muscarinic antagonists used for bronchodilation in COPD.',
            'tiotropium',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Aminoglycoside',
        title: 'Aminoglycoside - Wikipedia',
        folder: 'Antimicrobials',
        headings: ['Mechanism', 'Adverse effects', 'Dosing'],
        facts: [
          [
            'Aminoglycosides bind the 30S ribosomal subunit and cause misreading of mRNA; their killing is concentration-dependent.',
            '30S',
          ],
          [
            'Aminoglycosides need oxygen-dependent uptake, so they are ineffective against anaerobes.',
            'anaerobes',
          ],
          [
            'Nephrotoxicity and ototoxicity are the classic adverse effects of gentamicin, worsened by loop diuretics.',
            'ototoxicity',
          ],
          [
            'Once-daily dosing exploits the post-antibiotic effect and lowers trough concentrations.',
            'post-antibiotic effect',
          ],
          [
            'Aminoglycosides can worsen neuromuscular blockade and should be avoided in myasthenia gravis.',
            'myasthenia gravis',
          ],
        ],
      },
      {
        url: statpearls('NBK547662'),
        title: 'Drug Elimination - StatPearls - NCBI Bookshelf',
        folder: 'Pharmacokinetics',
        headings: ['Half-life', 'Clearance', 'Drug interactions'],
        facts: [
          [
            'Half-life equals 0.693 times the volume of distribution divided by clearance.',
            '0.693',
          ],
          [
            'Steady state is reached after about four to five half-lives regardless of the dose.',
            'four to five',
          ],
          [
            'A loading dose equals the target plasma concentration multiplied by the volume of distribution.',
            'volume of distribution',
          ],
          [
            'Zero-order elimination, seen with ethanol, phenytoin and high-dose aspirin, removes a constant amount per unit time.',
            'Zero-order',
          ],
          [
            'CYP3A4 inhibitors such as clarithromycin and grapefruit juice raise the levels of drugs like simvastatin.',
            'CYP3A4',
          ],
          [
            "Rifampicin, carbamazepine and St John's wort induce CYP enzymes and can cause contraceptive failure.",
            'Rifampicin',
          ],
        ],
      },
      {
        url: 'https://pubmed.ncbi.nlm.nih.gov/32191793/',
        title:
          'Therapeutic monitoring of vancomycin for serious methicillin-resistant Staphylococcus aureus infections: a revised consensus guideline - PubMed',
        folder: 'Antimicrobials',
        headings: ['Abstract'],
        facts: [
          [
            'AUC-guided dosing of vancomycin, targeting an AUC of 400 to 600 mg·h/L, is preferred over trough-only monitoring.',
            '400 to 600',
          ],
          [
            'Trough concentrations above 15 mg/L are associated with more acute kidney injury without better outcomes.',
            'acute kidney injury',
          ],
          [
            'Vancomycin infusion reaction (formerly red man syndrome) is histamine-mediated and is managed by slowing the infusion.',
            'slowing the infusion',
          ],
          [
            'Vancomycin inhibits cell wall synthesis by binding the D-Ala-D-Ala terminus of peptidoglycan precursors.',
            'D-Ala-D-Ala',
          ],
        ],
      },
    ],
  },
  {
    name: 'Cardiology',
    color: 'red',
    icon: '❤️',
    tags: ['arrhythmia', 'ecg', 'high-yield'],
    folders: [{ name: 'Arrhythmias' }, { name: 'Heart failure' }, { name: 'Physiology' }],
    sources: [
      {
        url: 'https://en.wikipedia.org/wiki/Atrial_fibrillation',
        title: 'Atrial fibrillation - Wikipedia',
        folder: 'Arrhythmias',
        headings: ['Diagnosis', 'Management', 'Anticoagulation'],
        facts: [
          [
            'Atrial fibrillation shows an irregularly irregular rhythm with no discernible P waves on the ECG.',
            'P waves',
          ],
          [
            'The CHA2DS2-VASc score estimates stroke risk in non-valvular atrial fibrillation and guides anticoagulation.',
            'CHA2DS2-VASc',
          ],
          [
            'Rate control with a beta blocker or non-dihydropyridine calcium channel blocker is first-line in stable patients.',
            'non-dihydropyridine',
          ],
          [
            'Haemodynamically unstable atrial fibrillation requires immediate synchronised DC cardioversion.',
            'synchronised',
          ],
          [
            'Most thrombi in non-valvular atrial fibrillation form in the left atrial appendage.',
            'left atrial appendage',
          ],
          [
            'Direct oral anticoagulants are preferred over warfarin except with mechanical valves or moderate-to-severe mitral stenosis.',
            'mechanical valves',
          ],
        ],
      },
      {
        url: statpearls('NBK430873'),
        title: 'Heart Failure - StatPearls - NCBI Bookshelf',
        folder: 'Heart failure',
        headings: ['Evaluation', 'Treatment / Management'],
        facts: [
          [
            'Heart failure with reduced ejection fraction is defined by an ejection fraction of 40% or less.',
            '40%',
          ],
          [
            'ACE inhibitors or ARNIs, beta blockers, mineralocorticoid antagonists and SGLT2 inhibitors are the four pillars of HFrEF therapy.',
            'SGLT2 inhibitors',
          ],
          [
            'BNP is released by ventricular myocytes in response to wall stretch; a normal level makes acute heart failure unlikely.',
            'wall stretch',
          ],
          [
            'Loop diuretics relieve congestion but have not been shown to reduce mortality in heart failure.',
            'mortality',
          ],
          [
            'Sacubitril inhibits neprilysin, raising natriuretic peptide levels, and is always combined with valsartan.',
            'neprilysin',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Cardiac_output',
        title: 'Cardiac output - Wikipedia',
        folder: 'Physiology',
        headings: ['Definition', 'Determinants'],
        facts: [
          ['Cardiac output equals heart rate multiplied by stroke volume.', 'stroke volume'],
          [
            'Mean arterial pressure is approximately diastolic pressure plus one third of the pulse pressure.',
            'one third',
          ],
          [
            'The Frank-Starling law states that stroke volume rises with end-diastolic volume, up to a limit.',
            'Frank-Starling',
          ],
          [
            'Ejection fraction equals stroke volume divided by end-diastolic volume.',
            'end-diastolic volume',
          ],
          [
            'Afterload is increased by aortic stenosis and hypertension, raising myocardial oxygen demand.',
            'aortic stenosis',
          ],
        ],
      },
      {
        url: statpearls('NBK459388'),
        title: 'Torsades de Pointes - StatPearls - NCBI Bookshelf',
        folder: 'Arrhythmias',
        headings: ['Etiology', 'Treatment / Management'],
        facts: [
          [
            'Torsades de pointes is a polymorphic ventricular tachycardia associated with a prolonged QT interval.',
            'polymorphic',
          ],
          [
            'Intravenous magnesium sulfate is first-line treatment for torsades de pointes, even when serum magnesium is normal.',
            'magnesium sulfate',
          ],
          [
            'Macrolides, fluoroquinolones, ondansetron, haloperidol and methadone are common QT-prolonging drugs.',
            'ondansetron',
          ],
          [
            'Hypokalaemia, hypomagnesaemia and hypocalcaemia all prolong the QT interval.',
            'hypocalcaemia',
          ],
          [
            "The QT interval should be corrected for heart rate, for example with Bazett's formula QTc = QT / √RR.",
            "Bazett's formula",
          ],
        ],
      },
      {
        url: 'https://pubmed.ncbi.nlm.nih.gov/34709879/',
        title: '2021 AHA/ACC Guideline for the Evaluation and Diagnosis of Chest Pain - PubMed',
        headings: ['Abstract'],
        facts: [
          [
            'High-sensitivity troponin is the preferred biomarker for diagnosing myocardial infarction.',
            'troponin',
          ],
          [
            'ST elevation in leads II, III and aVF indicates an inferior myocardial infarction, usually from the right coronary artery.',
            'right coronary artery',
          ],
          [
            'Door-to-balloon time for primary PCI in STEMI should be 90 minutes or less.',
            '90 minutes',
          ],
          [
            'Nitrates are contraindicated in right ventricular infarction and after recent phosphodiesterase-5 inhibitor use.',
            'phosphodiesterase-5',
          ],
          [
            'Dual antiplatelet therapy with aspirin and a P2Y12 inhibitor is continued for 12 months after an acute coronary syndrome.',
            'P2Y12',
          ],
        ],
      },
    ],
  },
  {
    name: 'Anatomy',
    color: 'teal',
    icon: '🦴',
    tags: ['upper-limb', 'nerve-injury', 'neuroanatomy'],
    folders: [
      { name: 'Upper limb', children: [{ name: 'Brachial plexus' }] },
      { name: 'Thorax' },
      { name: 'Head and neck' },
    ],
    sources: [
      {
        url: 'https://en.wikipedia.org/wiki/Brachial_plexus',
        title: 'Brachial plexus - Wikipedia',
        folder: 'Upper limb/Brachial plexus',
        headings: ['Structure', 'Injuries'],
        facts: [
          [
            'The brachial plexus is formed by the ventral rami of C5 to T1 and is organised into roots, trunks, divisions, cords and branches.',
            'C5 to T1',
          ],
          [
            "Erb's palsy follows injury to the upper trunk (C5-C6) and gives the 'waiter's tip' posture.",
            'upper trunk',
          ],
          [
            "Klumpke's palsy involves the lower trunk (C8-T1) and causes a claw hand, sometimes with Horner syndrome.",
            "Klumpke's palsy",
          ],
          [
            'The long thoracic nerve supplies serratus anterior; injury causes winging of the scapula.',
            'serratus anterior',
          ],
          [
            'The axillary nerve wraps around the surgical neck of the humerus and is at risk in shoulder dislocation.',
            'surgical neck',
          ],
          [
            'Radial nerve injury at the spiral groove causes wrist drop with preserved triceps function.',
            'wrist drop',
          ],
        ],
      },
      {
        url: statpearls('NBK448179'),
        title: 'Carpal Tunnel Syndrome - StatPearls - NCBI Bookshelf',
        folder: 'Upper limb',
        headings: ['Anatomy', 'History and Physical'],
        facts: [
          [
            'The median nerve passes through the carpal tunnel beneath the flexor retinaculum.',
            'flexor retinaculum',
          ],
          [
            'Carpal tunnel syndrome spares sensation over the thenar eminence because the palmar cutaneous branch runs superficial to the retinaculum.',
            'palmar cutaneous branch',
          ],
          ["Phalen's and Tinel's signs are bedside tests for carpal tunnel syndrome.", "Tinel's"],
          [
            'Pregnancy, hypothyroidism and rheumatoid arthritis are associated with carpal tunnel syndrome.',
            'hypothyroidism',
          ],
          ['Thenar wasting indicates longstanding median nerve compression.', 'Thenar wasting'],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Mediastinum',
        title: 'Mediastinum - Wikipedia',
        folder: 'Thorax',
        headings: ['Superior mediastinum', 'Posterior mediastinum'],
        facts: [
          [
            'The sternal angle marks the T4/T5 level: the tracheal bifurcation and the start and end of the aortic arch.',
            'T4/T5',
          ],
          [
            'The left recurrent laryngeal nerve hooks around the aortic arch, so aortic aneurysms can cause hoarseness.',
            'aortic arch',
          ],
          [
            'The phrenic nerves (C3-C5) pass anterior to the lung roots; the vagus nerves pass posterior.',
            'C3-C5',
          ],
          [
            'The thoracic duct drains into the venous angle at the junction of the left subclavian and internal jugular veins.',
            'left subclavian',
          ],
          [
            'The azygos vein arches over the right main bronchus to join the superior vena cava.',
            'azygos',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Facial_nerve',
        title: 'Facial nerve - Wikipedia',
        folder: 'Head and neck',
        headings: ['Course', 'Clinical significance'],
        facts: [
          [
            'An upper motor neuron facial lesion spares the forehead because of bilateral cortical innervation.',
            'forehead',
          ],
          [
            "Bell's palsy is an idiopathic lower motor neuron facial palsy; early oral corticosteroids improve recovery.",
            'corticosteroids',
          ],
          [
            'The chorda tympani carries taste from the anterior two thirds of the tongue.',
            'anterior two thirds',
          ],
          ['The nerve to stapedius explains hyperacusis in facial nerve palsy.', 'stapedius'],
          [
            'The facial nerve exits the skull through the stylomastoid foramen and divides within the parotid gland.',
            'stylomastoid foramen',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Circle_of_Willis',
        title: 'Circle of Willis - Wikipedia',
        folder: 'Head and neck',
        headings: ['Clinical significance'],
        facts: [
          [
            'The anterior communicating artery is the most common site of berry aneurysms.',
            'anterior communicating artery',
          ],
          [
            'A posterior communicating artery aneurysm can compress the oculomotor nerve and cause a dilated pupil.',
            'oculomotor nerve',
          ],
          [
            'The middle cerebral artery supplies the lateral cortex, including the face and arm areas of the motor cortex.',
            'middle cerebral artery',
          ],
          [
            'Lenticulostriate arteries are a common site of hypertensive haemorrhage and lacunar infarcts.',
            'Lenticulostriate',
          ],
        ],
      },
    ],
  },
  {
    name: 'Microbiology',
    color: 'green',
    icon: '🦠',
    tags: ['gram-positive', 'gram-negative', 'vaccines'],
    folders: [
      { name: 'Bacteria', children: [{ name: 'Gram-positive' }, { name: 'Gram-negative' }] },
      { name: 'Viruses' },
      { name: 'Vaccines' },
    ],
    sources: [
      {
        url: 'https://en.wikipedia.org/wiki/Staphylococcus_aureus',
        title: 'Staphylococcus aureus - Wikipedia',
        folder: 'Bacteria/Gram-positive',
        headings: ['Microbiology', 'Virulence factors', 'Antibiotic resistance'],
        facts: [
          [
            'Staphylococcus aureus is a coagulase-positive, catalase-positive Gram-positive coccus that grows in clusters.',
            'coagulase-positive',
          ],
          [
            'MRSA resistance comes from the mecA gene, which encodes an altered penicillin-binding protein (PBP2a).',
            'mecA',
          ],
          [
            'Toxic shock syndrome toxin-1 acts as a superantigen, cross-linking MHC II and T-cell receptors.',
            'superantigen',
          ],
          [
            'S. aureus food poisoning has a rapid onset of 1 to 6 hours because the enterotoxin is preformed.',
            'preformed',
          ],
          ['Protein A binds the Fc region of IgG and blocks opsonisation.', 'Protein A'],
        ],
      },
      {
        url: statpearls('NBK470537'),
        title: 'Streptococcus pneumoniae - StatPearls - NCBI Bookshelf',
        folder: 'Bacteria/Gram-positive',
        headings: ['Etiology', 'Pathophysiology'],
        facts: [
          [
            'Streptococcus pneumoniae is an alpha-haemolytic, optochin-sensitive, lancet-shaped diplococcus.',
            'optochin-sensitive',
          ],
          [
            'Its polysaccharide capsule is the main virulence factor and the basis of pneumococcal vaccines.',
            'polysaccharide capsule',
          ],
          [
            'S. pneumoniae is the most common cause of community-acquired pneumonia, meningitis in adults and otitis media in children.',
            'community-acquired pneumonia',
          ],
          [
            'Asplenic patients are at risk of overwhelming infection by encapsulated organisms such as S. pneumoniae.',
            'Asplenic',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Escherichia_coli',
        title: 'Escherichia coli - Wikipedia',
        folder: 'Bacteria/Gram-negative',
        headings: ['Pathogenic strains', 'Treatment'],
        facts: [
          [
            'E. coli is a lactose-fermenting Gram-negative rod and the leading cause of urinary tract infections.',
            'lactose-fermenting',
          ],
          [
            'EHEC O157:H7 produces Shiga-like toxin and can cause haemolytic uraemic syndrome.',
            'haemolytic uraemic syndrome',
          ],
          [
            'Antibiotics are avoided in EHEC infection because they may increase toxin release.',
            'toxin release',
          ],
          ['The K1 capsular antigen makes E. coli a major cause of neonatal meningitis.', 'K1'],
          [
            "ETEC causes traveller's diarrhoea through heat-labile and heat-stable enterotoxins.",
            "traveller's diarrhoea",
          ],
        ],
      },
      {
        url: 'https://www.cdc.gov/hepatitis-b/hcp/clinical-overview/index.html',
        title: 'Clinical Overview of Hepatitis B | Hepatitis B | CDC',
        folder: 'Viruses',
        headings: ['Serology', 'Prevention'],
        facts: [
          [
            'HBsAg is the first serological marker of hepatitis B infection; persistence beyond six months defines chronic infection.',
            'six months',
          ],
          ['Anti-HBs alone indicates immunity from vaccination.', 'Anti-HBs'],
          [
            'IgM anti-HBc may be the only positive marker during the window period.',
            'window period',
          ],
          ['HBeAg indicates active viral replication and high infectivity.', 'HBeAg'],
          [
            'Infants born to HBsAg-positive mothers need hepatitis B vaccine and HBIG within 12 hours of birth.',
            '12 hours',
          ],
        ],
      },
      {
        url: statpearls('NBK459363'),
        title: 'Influenza - StatPearls - NCBI Bookshelf',
        folder: 'Viruses',
        headings: ['Pathophysiology', 'Treatment / Management'],
        facts: [
          [
            'Antigenic drift from point mutations causes seasonal influenza; antigenic shift from reassortment causes pandemics.',
            'reassortment',
          ],
          [
            'Neuraminidase inhibitors such as oseltamivir are most effective when started within 48 hours of symptom onset.',
            '48 hours',
          ],
          [
            'Haemagglutinin binds sialic acid on respiratory epithelium to mediate viral entry.',
            'sialic acid',
          ],
          [
            'Secondary bacterial pneumonia after influenza is often caused by Staphylococcus aureus.',
            'Staphylococcus aureus',
          ],
        ],
      },
    ],
  },
  {
    name: 'Biochemistry',
    color: 'blue',
    icon: '🧪',
    tags: ['enzymes', 'vitamins', 'formula'],
    folders: [
      { name: 'Metabolism', children: [{ name: 'Glycolysis' }, { name: 'Lipids' }] },
      { name: 'Vitamins' },
      { name: 'Genetics' },
    ],
    sources: [
      {
        url: 'https://en.wikipedia.org/wiki/Glycolysis',
        title: 'Glycolysis - Wikipedia',
        folder: 'Metabolism/Glycolysis',
        headings: ['Regulation', 'Clinical significance'],
        facts: [
          [
            'Phosphofructokinase-1 catalyses the rate-limiting step of glycolysis and is activated by fructose-2,6-bisphosphate.',
            'Phosphofructokinase-1',
          ],
          ['Glycolysis yields a net of 2 ATP and 2 NADH per molecule of glucose.', '2 ATP'],
          [
            'Pyruvate kinase deficiency causes haemolytic anaemia because red cells depend entirely on glycolysis for ATP.',
            'Pyruvate kinase',
          ],
          [
            'Hexokinase has a low Km and is inhibited by glucose-6-phosphate; hepatic glucokinase has a high Km.',
            'glucokinase',
          ],
          [
            'Arsenic inhibits lipoic acid-dependent enzymes such as pyruvate dehydrogenase.',
            'lipoic acid',
          ],
        ],
      },
      {
        url: statpearls('NBK441923'),
        title: 'Vitamin B12 Deficiency - StatPearls - NCBI Bookshelf',
        folder: 'Vitamins',
        headings: ['Evaluation', 'Complications'],
        facts: [
          [
            'Vitamin B12 deficiency causes megaloblastic anaemia with raised methylmalonic acid and homocysteine.',
            'methylmalonic acid',
          ],
          [
            'Folate deficiency raises homocysteine but methylmalonic acid stays normal.',
            'homocysteine',
          ],
          [
            'Subacute combined degeneration affects the dorsal columns and lateral corticospinal tracts.',
            'dorsal columns',
          ],
          [
            'Pernicious anaemia is caused by antibodies to intrinsic factor or parietal cells.',
            'intrinsic factor',
          ],
          [
            'Giving folate alone to a B12-deficient patient can correct the anaemia while neurological damage progresses.',
            'neurological damage',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Thiamine',
        title: 'Thiamine - Wikipedia',
        folder: 'Vitamins',
        headings: ['Function', 'Deficiency'],
        facts: [
          [
            'Thiamine pyrophosphate is a cofactor for pyruvate dehydrogenase, alpha-ketoglutarate dehydrogenase and transketolase.',
            'transketolase',
          ],
          [
            'Wernicke encephalopathy presents with confusion, ophthalmoplegia and ataxia.',
            'ophthalmoplegia',
          ],
          [
            'Give thiamine before glucose in malnourished or alcohol-dependent patients to avoid precipitating Wernicke encephalopathy.',
            'before glucose',
          ],
          ['Wet beriberi causes high-output heart failure.', 'high-output'],
        ],
      },
      {
        url: 'https://medlineplus.gov/genetics/condition/familial-hypercholesterolemia/',
        title: 'Familial hypercholesterolemia: MedlinePlus Genetics',
        folder: 'Metabolism/Lipids',
        headings: ['Description', 'Causes'],
        facts: [
          [
            'Familial hypercholesterolaemia is usually caused by mutations in the LDL receptor gene and is autosomal dominant.',
            'LDL receptor',
          ],
          [
            'Tendon xanthomas, especially of the Achilles tendon, suggest familial hypercholesterolaemia.',
            'Achilles',
          ],
          [
            'Statins inhibit HMG-CoA reductase, the rate-limiting enzyme of cholesterol synthesis.',
            'HMG-CoA reductase',
          ],
          [
            'PCSK9 inhibitors increase LDL receptor recycling and lower LDL cholesterol by about 60%.',
            'PCSK9',
          ],
          [
            'Lipoprotein lipase deficiency causes very high triglycerides and recurrent pancreatitis.',
            'pancreatitis',
          ],
        ],
      },
      {
        url: 'https://en.wikipedia.org/wiki/Michaelis%E2%80%93Menten_kinetics',
        title: 'Michaelis–Menten kinetics - Wikipedia',
        headings: ['Model', 'Inhibition'],
        facts: [
          [
            'Km is the substrate concentration at which the reaction rate is half of Vmax.',
            'half of Vmax',
          ],
          ['Competitive inhibitors raise the apparent Km without changing Vmax.', 'Competitive'],
          ['Non-competitive inhibitors lower Vmax without changing Km.', 'Non-competitive'],
          [
            'On a Lineweaver-Burk plot, the y-intercept is 1/Vmax and the x-intercept is -1/Km.',
            '1/Vmax',
          ],
          ['The Michaelis-Menten equation is v = Vmax[S] / (Km + [S]).', 'Km + [S]'],
        ],
      },
      {
        url: 'https://pubmed.ncbi.nlm.nih.gov/31761331/',
        title: 'Cystic fibrosis: a review of pathophysiology and therapies - PubMed',
        folder: 'Genetics',
        headings: ['Abstract'],
        facts: [
          [
            'Cystic fibrosis is caused by mutations in CFTR, most commonly the F508del deletion, which causes protein misfolding.',
            'F508del',
          ],
          [
            'A sweat chloride above 60 mmol/L supports the diagnosis of cystic fibrosis.',
            '60 mmol/L',
          ],
          [
            'CFTR modulators such as elexacaftor-tezacaftor-ivacaftor improve lung function in eligible genotypes.',
            'CFTR modulators',
          ],
        ],
      },
    ],
  },
];

/** Saved before the person organised anything: they stay in the Inbox. */
export const INBOX_SOURCES: readonly SourceSpec[] = [
  {
    url: 'https://en.wikipedia.org/wiki/Hyperkalemia',
    title: 'Hyperkalemia - Wikipedia',
    headings: ['Treatment'],
    facts: [
      [
        'Hyperkalaemia with ECG changes is treated first with intravenous calcium gluconate to stabilise the myocardium.',
        'calcium gluconate',
      ],
    ],
  },
  {
    url: statpearls('NBK482146'),
    title: 'Metabolic Acidosis - StatPearls - NCBI Bookshelf',
    headings: ['Evaluation'],
    facts: [
      [
        'The anion gap equals sodium minus the sum of chloride and bicarbonate; the normal range is about 8 to 12 mmol/L.',
        '8 to 12',
      ],
      [
        "Winter's formula predicts the expected PaCO2 in metabolic acidosis: 1.5 × HCO3 + 8 ± 2.",
        "Winter's formula",
      ],
    ],
  },
  {
    url: statpearls('NBK470386'),
    title: 'Hyponatremia - StatPearls - NCBI Bookshelf',
    headings: ['Treatment / Management'],
    facts: [
      [
        'Correct chronic hyponatraemia by no more than 8 to 10 mmol/L in 24 hours to avoid osmotic demyelination.',
        'osmotic demyelination',
      ],
      [
        'Is the fluid restriction target in SIADH 800 mL per day or 1 L per day? Check the lecture slides.',
        'fluid restriction',
      ],
    ],
  },
  {
    url: 'https://en.wikipedia.org/wiki/Spironolactone',
    title: 'Spironolactone - Wikipedia',
    headings: ['Side effects'],
    facts: [
      [
        'Spironolactone causes gynaecomastia through anti-androgen effects; eplerenone is more selective.',
        'eplerenone',
      ],
    ],
  },
];

export const COMMENTS = [
  'Classic exam question.',
  'Came up in the block 3 quiz.',
  'Compare with the table on lecture slide 14.',
  'Mnemonic is in my notebook.',
  'I keep mixing this up with the next one.',
  'Ask in Thursday tutorial.',
  'Check against First Aid before the exam.',
  'Good flashcard material.',
] as const;

/** Markdown study notes, attached to the highlight whose quote contains `match`. */
export const NOTES: readonly { match: string; body: string; pinned?: boolean }[] = [
  {
    match: 'Cardioselective agents',
    pinned: true,
    body: '**Beta blocker selectivity**\n\n- Cardioselective: *A to M* (atenolol, bisoprolol, metoprolol)\n- Non-selective: *N to Z* (nadolol, propranolol, timolol)\n- Exceptions: carvedilol and labetalol also block alpha-1',
  },
  {
    match: 'Cardiac output equals',
    body: 'Formulas to know:\n\n$CO = HR \\times SV$\n\n$MAP \\approx DBP + \\frac{1}{3}(SBP - DBP)$',
  },
  {
    match: 'Anticholinergic toxicity',
    body: '## Anticholinergic toxidrome\n\n1. Hyperthermia\n2. Dry skin and mucosa\n3. Flushing\n4. Mydriasis\n5. Delirium\n\nSupportive care first; physostigmine only after toxicology advice.',
  },
  {
    match: 'CHA2DS2-VASc',
    body: 'CHA2DS2-VASc: **C**HF, **H**TN, **A**ge ≥75 (2), **D**M, **S**troke/TIA (2), **V**ascular disease, **A**ge 65-74, **S**ex category (female).\n\nAnticoagulate men with ≥2, women with ≥3.',
  },
  {
    match: 'brachial plexus is formed',
    body: 'Mnemonic for the parts: **R**andy **T**ravis **D**rinks **C**old **B**eer (roots, trunks, divisions, cords, branches).',
  },
  {
    match: 'HBsAg is the first',
    body: '| Marker | Meaning |\n| --- | --- |\n| HBsAg | infection |\n| Anti-HBs | immunity |\n| IgM anti-HBc | acute / window |\n| HBeAg | replication |',
  },
  {
    match: 'Km is the substrate',
    body: 'Lower Km means **higher affinity**. Draw the Lineweaver-Burk plot from memory before the exam.',
  },
  {
    match: 'Vitamin B12 deficiency causes',
    body: 'B12 vs folate: both raise homocysteine; only B12 raises MMA and causes neurological signs.',
  },
];
