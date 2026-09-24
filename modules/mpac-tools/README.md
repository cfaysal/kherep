# MPAC Query-Sammlung (`mpac.ps1`)

Reusable Atlassian-Marketplace-Abfragen für ein explizit konfiguriertes
Vendor-Konto.

## Basis und Auth

- Basis: `https://api.atlassian.com/marketplace`, Pfade `/rest/3/...`
- Auth: HTTP Basic, unverändert gegenüber V2. Das bestehende Vendor-Token trägt.
  Beleg aus dem OpenAPI-Schema: `securitySchemes: {"mpac_authed":{"type":"http","scheme":"basic"}}`
- Der Credential-Pfad steht **nicht** im Quelltext. `KHEREP_MPAC_CRED_FILE`
  muss explizit auf eine Datei mit Account-E-Mail, numerischer Vendor-ID und
  Token zeigen. Eine fehlende Bindung oder ein fehlender Wert führt zu einem
  harten Fehler. Das Script gibt den Token **nie** aus.

## Die Doku-Falle (kostet sonst eine Stunde)

Das URL-Segment der Atlassian-Doku entspricht **nicht** der API-Version:

| Doku-URL | Inhalt |
|---|---|
| `/platform/marketplace/rest/v2/` | Marketplace REST API (v2), abgeschaltet |
| `/platform/marketplace/rest/v1/` | Promotions REST API |
| `/platform/marketplace/rest/v3/` | Product Tags REST API |
| `/platform/marketplace/rest/v4/` | **Marketplace REST API (v3)** - die gesuchte |

Wer aus der 410-Meldung „migrate to V3" auf `/rest/v3/` schliesst, landet bei
Product Tags und findet keinen einzigen Reporting-Pfad.

## Die Paging-Falle

Die JSON-Listen-Endpoints liefern **10 Zeilen pro Seite** plus `_links.next`.
Wer die roh summiert, bekommt eine falsche Gesamteinnahme. Die Variante
`/export?accept=json` liefert weiterhin den vollen Satz als bares Array, exakt
wie unter V2. Deshalb nutzen `Get-MpacTransactions` und `Get-MpacLicenses` den
Export-Pfad, und die Analyse-Helfer blieben unverändert.

## Nutzung

```powershell
. .\tools\mpac\mpac.ps1            # einmal dot-sourcen

Get-MpacEarnings                  # Gesamteinnahme + pro App (Summe vendorAmount)
Get-MpacTransactions              # rohe Transaktionen (all-time)
Get-MpacLicenses                  # alle Lizenzen   (-AddonKey filtert auf 1 App)
Get-MpacLicenseBreakdown          # Lizenzen nach Typ/Status ($0 disambiguieren)
Get-MpacSandboxHosts              # Non-Prod-Hosts flaggen (cloudSiteHostname)

Get-MpacReportCatalog             # welche Reports + ob Pfad verifiziert
Get-MpacReport -Name churn        # Report per Name
Invoke-Mpac -Path '/rest/3/reporting/developer-space/{developerId}/...'  # beliebiger Pfad
```

`{developerId}` wird automatisch aufgelöst. V3 hängt alles an der `developerId`
statt an der numerischen `vendorId`; die Umrechnung läuft einmal pro Session
über `/rest/3/developer-space/vendor/{vendorId}` und wird gecacht.

## Berichtskatalog

| Query | Status |
|---|---|
| `transactions`, `licenses`, `feedback`, `churn`, `conversions`, `renewals` | im Katalog |
| `evaluations` | Pfad braucht einen Metrik-Namen, zulässige Werte ungeprüft -> `-Force` |
| `Get-MpacPricing` | **nicht verfügbar.** Im V3-Schema (76 Pfade) wurde kein Ersatz für `pricing/cloud/live` gefunden. Das ist ein „nicht gefunden", kein belegtes „existiert nicht". Die Funktion wirft bewusst, statt still einen toten Pfad zu rufen. |

Bei 404 auf einen unverifizierten Pfad: exakten Pfad in der jeweiligen
`api-group`-Seite auf developer.atlassian.com gegenprüfen, **nicht raten**.
Die Doku-Falle oben dabei beachten.

## Privacy

Der Output (Earnings, Kunden-Lizenzen, Hostnames) ist Privacy-Gate. In lokale
Dateien schreiben, nicht in ein Cloud-LLM oder einen Chat pasten. Für
Funktionsprüfungen genügen Zeilenzahlen und Statuscodes.

## Neu unter V3 verfügbar

Vorher nicht vorhanden, jetzt abrufbar: Customer Insights nach Region, Tier,
Edition und Active Users, Such-Keywords inklusive Zero-Result-Keywords,
Benchmarks für Sales und Evaluations, Quotes, Reviews samt Antwort-Endpoint,
Privacy-and-Security-Formular, Partner-Metrics-Zeitreihen. Alles unter
`/rest/3/reporting/developer-space/{developerId}/...` beziehungsweise
`/rest/3/products/{productId}/reviews`.
