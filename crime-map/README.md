# Mapa krimi zpráv z USA

Mapa 50 států + DC. Server každých 15 minut stáhne aktuální krimi zprávy pro každý stát,
web je zobrazí (kliknutí na stát = jeho zprávy). Žádné závislosti, jen Node.js 18+.

## Spuštění

    node server.js
    # otevři http://localhost:3000

První data se objeví za cca 1–2 minuty (stahuje se 51 dotazů s malými pauzami).
Výsledek se ukládá do `data/cache.json`, takže po restartu mapa není prázdná.

## Nastavení (proměnné prostředí)

| Proměnná           | Výchozí | Význam                                              |
|--------------------|---------|-----------------------------------------------------|
| `PORT`             | 3000    | port serveru                                        |
| `REFRESH_MINUTES`  | 15      | jak často se zprávy obnovují                        |
| `GNEWS_API_KEY`    | –       | když je zadán, použije se GNews API místo RSS       |

## Odkud zprávy jsou

- **Výchozí: Google News RSS** (bez klíče, zdarma). Pro každý stát se hledá `crime/shooting/arrested/police + název státu`
  za posledních 48 hodin. Hodí se pro osobní projekt a vyzkoušení; pro veřejný/komerční web si zkontroluj podmínky použití.
- **GNews API** (`GNEWS_API_KEY`): stabilnější a oficiální. Pozor na limity: zdarma jen 100 dotazů denně,
  což při 51 státech vystačí na 1–2 obnovení denně. Pro živou mapu je potřeba placený tarif
  (nebo nastav `REFRESH_MINUTES` vysoko).

## Nasazení

Jakýkoli hosting, kde běží Node (Render, Railway, Fly.io, VPS). Příkaz `node server.js`, nic dalšího se neinstaluje.
Server musí běžet nepřetržitě, jinak se zprávy neaktualizují.

## Známá omezení

- Zprávy se přiřazují ke státu podle klíčových slov, občas se proto vloudí článek o jiném místě
  (např. město stejného jména). Nejproblematičtější názvy (Washington, Virginia, Georgia) mají vlastní ošetření.
- Zobrazujeme jen titulek, zdroj a odkaz na původní článek. Texty článků nekopíruj.
