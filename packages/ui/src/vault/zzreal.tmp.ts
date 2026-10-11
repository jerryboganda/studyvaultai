// TEMPORARY realistic-note generator for calibration (deleted after use).
const SECTION = (i: number) => `## ${i}. The cell membrane and transport

The **plasma membrane** is a *phospholipid bilayer* with embedded proteins (see [Alberts, Molecular Biology of the Cell](https://example.com/mbc/${i})). It is _selectively permeable_: small non-polar molecules such as O2 and CO2 cross freely, while ions and polar molecules need \`channel\` or \`carrier\` proteins. Remember that the fluid mosaic model (Singer & Nicolson, 1972) describes lateral movement; flip-flop is rare and needs flippases. Resting potential is about -70 mV, and the Nernst equation $E = \\frac{RT}{zF}\\ln\\frac{[X]_o}{[X]_i}$ gives the equilibrium potential for one ion.

### Key points

- **Simple diffusion**: down the gradient, no energy, no protein.
- **Facilitated diffusion**: channels (gated) or carriers (saturable, specific).
  - Voltage-gated Na+ channels open at about -55 mV.
  - Ligand-gated channels such as the nicotinic ACh receptor.
    - Subunits: alpha, beta, gamma, delta.
- **Active transport**: primary (Na+/K+ ATPase, 3 Na+ out, 2 K+ in) and secondary (SGLT1).
- [ ] Re-read the section on osmosis
- [x] Make flashcards for the transporters

1. Identify the gradient.
2. Decide whether a protein is needed.
3. Check whether ATP is consumed directly.

> "The membrane is not a passive wall but a dynamic, regulated interface." This is the central idea of the chapter.

| Transport | Energy | Protein | Example |
|---|---|---|---|
| Simple diffusion | none | none | O2 |
| Facilitated | none | channel or carrier | GLUT4 |
| Primary active | ATP | pump | Na+/K+ ATPase |
| Secondary active | gradient | symporter | SGLT1 |

\`\`\`python
def nernst(z, conc_out, conc_in, T=310):
    # E = (RT / zF) * ln(Co / Ci)
    R, F = 8.314, 96485
    return (R * T) / (z * F) * math.log(conc_out / conc_in)

for ion in ["Na", "K", "Cl"]:
    print(ion, nernst(1, 145, 12))
\`\`\`

Display math for the Goldman equation:

$$
V_m = \\frac{RT}{F}\\ln\\frac{P_K[K]_o + P_{Na}[Na]_o + P_{Cl}[Cl]_i}{P_K[K]_i + P_{Na}[Na]_i + P_{Cl}[Cl]_o}
$$

---

Further reading: [Khan Academy](https://example.org/khan), [Wikipedia](https://en.wikipedia.org/wiki/Cell_membrane) and the lecture slides at https://example.edu/slides/${i}.pdf. Contact: tutor@example.edu.

`;

/** About `chars` characters of a plausible study note. */
export function realisticNote(chars: number): string {
  let out = '# Cell physiology revision\n\n';
  for (let i = 1; out.length < chars; i++) out += SECTION(i);
  return out.slice(0, chars);
}
