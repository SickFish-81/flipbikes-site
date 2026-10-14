# The invoice PDF fonts

`flip-sans.ttf` and `flip-sans-bold.ttf` are **subsets of DejaVu Sans**, copied
from the Betterservice app (`public/fonts/bs-sans*.ttf`). Its `lib/FONTS.md` is
the full account; this is the short version and the bit specific to the shop.

## Why they exist

The fourteen fonts built into every PDF reader are WinAnsi-encoded, and WinAnsi
has no macron vowels. Drawing "Māhia" with one of them is not a near miss:
pdf-lib refuses to guess and **throws**, which left Betterservice's rental
invoice #01065 with no PDF at all on 10 Oct 2026. jsPDF is worse because it is
silent — the character is dropped and the line still reads like a sentence.

New Zealand customer names contain macrons. A tax invoice with a customer's
name spelled wrong is not a cosmetic problem.

## Why they are subsets

Full DejaVu Sans plus bold is 1.4 MB. These are 17 KB and 16 KB, and pdf-lib
subsets them again on embed — a finished invoice is about 11 KB.

## What is in them

ASCII, Latin-1, the te reo macrons (Ā ā Ē ē Ī ī Ō ō Ū ū), and the dashes and
curly quotes that arrive pasted out of Word and email.

**A character outside that set will not print**, and nothing will warn you.
If one is ever needed, regenerate rather than reaching for the full font —
the recipe is in Betterservice's `lib/FONTS.md`.

## If these files go missing

`invoicePdf.js` logs it and returns null, the attachment is dropped, and the
emails still go out. Deliberate: this runs after the customer has paid.
`vercel.json` lists this folder in `includeFiles` so the deploy carries it.
