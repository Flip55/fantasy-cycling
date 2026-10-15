# Fantasy Cycling

Gesloten-enveloppe veiling + UCI-punten klassement voor een wielerwedstrijd, te spelen met vrienden.
Frontend op GitHub Pages, data in één Google Sheet via Google Apps Script. Volledig gratis.

```
index.html             de site (GitHub Pages)
apps-script/Code.gs    backend (Google Apps Script, gekoppeld aan je Google Sheet)
tests/                 node-tests + lokale mock server
```

## Spelregels (samenvatting)

- Elke speler: 100M budget, 1–20 renners.
- 3 rondes gesloten biedingen, per miljoen, min. 1M, geen maximum.
- Som van je biedingen in een ronde ≤ je resterende budget. Een bod is definitief.
- Hoogste bod wint en betaalt. Ex aequo: niemand, renner blijft vrij.
- Na elke ronde zijn alle biedingen openbaar.
- Punten = UCI-punten zoals PCS ze toont, verwerkt om 22u; latere correcties tellen niet.
- Resterend budget is tiebreaker in het eindklassement.
- Het Klassement toont het totaal, of per verwerkte uitslag (Etappe 1, Etappe 2, …, eindklassementen): zelfde knoppen bovenaan schakelen ook de Topscorers mee.

De volledige tekst staat in de app onder **Regels**.

## Setup (±15 minuten)

### 1. Google Sheet + Apps Script

1. Maak een nieuwe Google Sheet (bv. "Fantasy Guangxi").
2. Menu **Extensies → Apps Script**. Verwijder de inhoud van `Code.gs` en plak de inhoud van `apps-script/Code.gs`. Opslaan.
3. Kies bovenaan de functie **`setup`** en klik **Uitvoeren**. Geef toestemming (eigen account, "Advanced → Go to … (unsafe)" is normaal voor eigen scripts).
   De sheet krijgt nu de tabs Config, Players, Riders, Bids, Results, Log. In **Config** staat `adminToken` — dat is je notaris-code.
4. **Implementeren → Nieuwe implementatie → type: Web-app**
   - Uitvoeren als: **Ik**
   - Toegang: **Iedereen**
   - Implementeren → kopieer de **web-app URL** (eindigt op `/exec`).

> Bij elke latere wijziging aan Code.gs: Implementeren → Implementaties beheren → potlood → versie "Nieuw" → Implementeren. Anders blijft de oude code draaien.

### 2. GitHub Pages

1. Maak een repo (bv. `fantasy-cycling`) en zet `index.html` erin.
2. Open `index.html` en vul bovenaan het script `API_URL` in met je web-app URL.
3. Repo **Settings → Pages → Source: Deploy from a branch → main / (root)**. Na een minuut staat de site op `https://<jouw-naam>.github.io/fantasy-cycling/`.

### 3. Spel opzetten (tab Admin)

1. Vul je admin code in (uit Config).
2. **Spelers toevoegen** → elke speler krijgt een 6-tekencode; bezorg die privé.
3. **Startlijst**: open op PCS de startlist van de wedstrijd, selecteer alles, kopieer, plak in het vak, importeer. Controleer in de tab **Renners** (of in de sheet) of ploegen en namen kloppen; fouten corrigeer je rechtstreeks in de sheet.
4. **Ronde openen** met een deadline-tekst. Spelers loggen in en bieden. Op de deadline klik je **Ronde sluiten & toewijzen**. Herhaal voor ronde 2 en 3.
5. **Resultaten** stuurt iedereen zelf door via de tab **Resultaten** en de PCS-knop (bookmarklet): op de PCS-uitslag klikken → voorbeeld op de site → Verzenden. Het label volgt uit de PCS-URL (`stage-3`, `gc`, `points`, `kom`, `youth`); tussenstanden (`stage-3-gc`) en andere wedstrijden worden geweigerd. Een uitslag kan opnieuw doorgestuurd worden tot `lockHour` (22u Brussel) op de dag van de eerste import, daarna staat hij vast. Als notaris kan je in Admin altijd overschrijven of verwijderen. Config-sleutels: `raceSlug` (deel van de PCS-URL), `stages`, `lockHour`.

Alles staat ook gewoon in de sheet: je kan daar manueel corrigeren (bv. een naam, een puntenregel) — de site leest live uit de sheet.

## Lokaal testen

```
node tests/test.js            # logica-tests (veiling, parsers)
node tests/mock-server.js     # mock backend + site op http://localhost:8787
node tests/page-smoke.js      # smoke test van de pagina tegen de mock
node tests/e2e-results.js     # bookmarklet → site → backend, in Chromium (playwright)
```

## Beperkingen / bekend

- Spelerscodes zijn geen echte authenticatie; prima onder vrienden.
- Apps Script heeft 1–2 s vertraging per request.
- Resultaten komen via de PCS-knop uit de browser van een speler: PCS staat geautomatiseerd ophalen door servers niet toe.
- Punten voor het dragen van een leiderstrui staan niet in de PCS-uitslagtabellen en tellen dus niet mee.
- Volgende stap voor een seizoen/klassiekers: meerdere wedstrijden per spel (nu: één wedstrijd).
