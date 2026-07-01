# Luca Trading Definitivo CSV Reale

Versione locale completa.

## Avvio

```bash
cd ~/Downloads/Luca_Trading_Definitivo_CSV_Reale
npm install
npm run dev
```

Apri:

```text
http://localhost:3000
```

## Nota importante

La generazione automatica ora pesca davvero dal CSV:

- se i campi scenario sono vuoti, usa valori reali OHLC casuali dal CSV;
- se inserisci un prezzo scenario, lo usa come riferimento e prende il valore reale OHLC più vicino nel CSV;
- nella tabella trovi anche la sorgente del valore: `CSV open`, `CSV high`, `CSV low`, `CSV close`.

Tutti i valori restano modificabili manualmente.
