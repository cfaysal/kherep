# mpac.ps1 - Kherep Atlassian Marketplace (MPAC) Query-Sammlung
# ---------------------------------------------------------------------------
# Dot-source und dann Funktionen aufrufen:   . .\tools\mpac\mpac.ps1
#
# PRIVACY (SO#10): Der Pfad zur Cred-Datei steht NICHT mehr im Quelltext, er
# wird zur Laufzeit aufgeloest (siehe Resolve-MpacCredPath). Das Token wird nie
# ausgegeben oder geloggt. Der Output (Earnings, Kunden-Lizenzen, Hostnames)
# ist Privacy-Gate -> in lokale Dateien schreiben, NICHT in ein Cloud-LLM oder
# einen Chat pasten.
#
# --- V3-MIGRATION -----------------------------------------------------------
# Die Marketplace-V2-API wurde am 30.06.2026 abgeschaltet (CHANGE-3257,
# "complete sunset of the V2 API surface"). Authentifizierte Calls auf
# /rest/2 antworten seither mit HTTP 410 API_DEPRECATED.
#
# DOKU-FALLE: Das URL-Segment der Atlassian-Doku entspricht NICHT der
# API-Version. Wer aus "V3" auf /rest/v3/ schliesst, landet bei Product Tags.
#   /platform/marketplace/rest/v2/  -> Marketplace REST API (v2), tot
#   /platform/marketplace/rest/v3/  -> Product Tags REST API
#   /platform/marketplace/rest/v4/  -> Marketplace REST API (v3)  <-- DIESE
#
# Geaendert hat sich: Host, Pfad-Praefix, und vendorId -> developerId.
# Auth ist unveraendert HTTP Basic (securitySchemes: {"type":"http",
# "scheme":"basic"}), das bestehende Token traegt weiter.
#
# PAGING-FALLE: Die JSON-Listen-Endpoints (.../sales/transactions) liefern nur
# 10 Zeilen pro Seite plus ein _links.next. Wer die roh summiert, bekommt eine
# falsche Gesamtsumme. Die /export?accept=json-Variante liefert weiterhin den
# vollen Satz als BARES Array - identisch zur alten V2-Form. Deshalb bleiben
# die Analyse-Helfer unten unveraendert. Gegengemessen 2026-08-25: Paging und
# Export liefern dieselbe Zeilenzahl.
# ---------------------------------------------------------------------------

$script:MpacBase        = 'https://api.atlassian.com/marketplace'
$script:MpacDeveloperId = $null   # Laufzeit-Cache, siehe Get-MpacDeveloperId

# --- intern: Cred-Pfad aufloesen -------------------------------------------
# Reihenfolge: expliziter Override, sonst abgeleitet aus der bereits etablierten
# Ein hart eingetragener Pfad wuerde die Datei zu einem Privacy-Artefakt machen
# und liesse sich weder committen noch mit Werkzeugen bearbeiten.
function Get-ProductEnv {
    param([string]$Suffix)
    $canonical = "KHEREP_$Suffix"
    if (Test-Path -LiteralPath "Env:$canonical") {
        return [pscustomobject]@{ Present = $true; Value = (Get-Item -LiteralPath "Env:$canonical").Value; Name = $canonical }
    }
    return [pscustomobject]@{ Present = $false; Value = $null; Name = $canonical }
}

function Resolve-MpacCredPath {
    [CmdletBinding()]
    param()
    $mpac = Get-ProductEnv 'MPAC_CRED_FILE'
    if ($mpac.Present) {
        if (-not $mpac.Value) { throw "$($mpac.Name) must not be empty." }
        return $mpac.Value
    }
    throw 'Kein Cred-Pfad aufloesbar. Setze KHEREP_MPAC_CRED_FILE.'
}

# --- intern: Auth bauen (Email/VendorId/Token per Muster erkennen) ----------
function Get-MpacAuth {
    [CmdletBinding()]
    param([string]$CredPath)

    if (-not $CredPath) { $CredPath = Resolve-MpacCredPath }
    if (-not (Test-Path $CredPath)) { throw 'MPAC creds nicht gefunden (Pfad aus KHEREP_MPAC_CRED_FILE bzw. abgeleitet).' }

    $lines = Get-Content -LiteralPath $CredPath | ForEach-Object { $_.Trim() } |
             Where-Object { $_ -ne '' }

    $vendorId = $lines | Where-Object { $_ -match '^\d{3,}$' } | Select-Object -First 1
    # Token = laengste Zeile (Atlassian-Token ~192 Zeichen)
    $token    = $lines | Where-Object { $_ -ne $vendorId } |
                Sort-Object Length -Descending | Select-Object -First 1
    # Username = explizite @-Zeile in der gebundenen Credential-Datei.
    $email    = $lines | Where-Object { $_ -match '@' } | Select-Object -First 1

    if (-not $vendorId) { throw 'Keine Vendor-ID-Zeile (nur Ziffern) in der Cred-Datei gefunden.' }
    if (-not $token)    { throw 'Keine Token-Zeile in der Cred-Datei gefunden.' }
    if (-not $email)    { throw 'Keine Account-Email-Zeile in der Cred-Datei gefunden.' }

    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${email}:${token}"))
    [pscustomobject]@{
        VendorId = $vendorId
        Headers  = @{ Authorization = "Basic $b64"; Accept = 'application/json' }
    }
}

# --- intern: vendorId -> developerId aufloesen (V3 haengt alles daran) ------
# Einmal pro Session aufgeloest und gecacht. Die developerId ist ein
# Account-Identifier und wird bewusst NICHT ausgegeben.
function Get-MpacDeveloperId {
    [CmdletBinding()]
    param($Auth)
    if ($script:MpacDeveloperId) { return $script:MpacDeveloperId }
    if (-not $Auth) { $Auth = Get-MpacAuth }
    $uri = "$script:MpacBase/rest/3/developer-space/vendor/$($Auth.VendorId)"
    $res = Invoke-RestMethod -Uri $uri -Headers $Auth.Headers -Method Get -ErrorAction Stop
    if (-not $res.developerId) { throw "Keine developerId fuer Vendor $($Auth.VendorId) erhalten." }
    $script:MpacDeveloperId = $res.developerId
    $script:MpacDeveloperId
}

# --- generischer GET (jeder MPAC-Pfad) --------------------------------------
# Platzhalter: {developerId} wird aufgeloest, {vendorId}/{id} bleibt die
# numerische Vendor-ID (nur noch fuer die Bruecken-Route noetig).
function Invoke-Mpac {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,   # z.B. /rest/3/reporting/developer-space/{developerId}/licenses
        [hashtable]$Query
    )
    $auth = Get-MpacAuth
    $path = $Path
    if ($path -match '\{developerId\}') {
        $path = $path -replace '\{developerId\}', (Get-MpacDeveloperId -Auth $auth)
    }
    $path = $path -replace '\{(vendorId|id)\}', $auth.VendorId
    $uri  = "$script:MpacBase$path"
    if ($Query -and $Query.Count) {
        $qs  = ($Query.GetEnumerator() | ForEach-Object { "$($_.Key)=$([uri]::EscapeDataString([string]$_.Value))" }) -join '&'
        $uri = "$uri" + ($(if ($path -match '\?') { '&' } else { '?' })) + $qs
    }
    Invoke-RestMethod -Uri $uri -Headers $auth.Headers -Method Get -ErrorAction Stop
}

# Schreibender Gegenpart zu Invoke-Mpac. Bewusst getrennt, damit ein Tippfehler
# im Pfad nie versehentlich schreibt: die Methode muss explizit genannt werden.
#
# Die Listing-Endpunkte sind Vollersetzungen mit optimistischem Sperren. Die API
# schreibt den Ablauf selbst vor: erst GET, dann ausschliesslich die gewuenschten
# Felder aendern, alle uebrigen Felder unveraendert mitschicken, revision aus dem
# GET uebernehmen. Ein Teilkoerper leert die nicht gesendeten Felder.
#
# state und approvalStatus sind Pflicht und werden unveraendert zurueckgereicht:
# "Approval status transitions are not allowed" laut Spec, ein Schreibzugriff
# loest also keinen Freigabe-Zyklus aus.
function Invoke-MpacWrite {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][ValidateSet('PUT','POST','PATCH','DELETE')][string]$Method,
        [string]$Body
    )
    $auth = Get-MpacAuth
    $path = $Path
    if ($path -match '\{developerId\}') {
        $path = $path -replace '\{developerId\}', (Get-MpacDeveloperId -Auth $auth)
    }
    $path = $path -replace '\{(vendorId|id)\}', $auth.VendorId
    $uri  = "$script:MpacBase$path"

    $headers = @{} + $auth.Headers
    $headers['Content-Type'] = 'application/json'

    if ($PSBoundParameters.ContainsKey('Body')) {
        Invoke-RestMethod -Uri $uri -Headers $headers -Method $Method -Body $Body -ErrorAction Stop
    } else {
        Invoke-RestMethod -Uri $uri -Headers $headers -Method $Method -ErrorAction Stop
    }
}

# === VERIFIZIERTE Queries (gegen Konto gerunnt 2026-08-25) ==================

# Alle Transaktionen (all-time). vendorAmount = echte Einnahme.
# export = voller Satz als bares Array; die gepagete Variante waere unvollstaendig.
function Get-MpacTransactions {
    Invoke-Mpac -Path '/rest/3/reporting/developer-space/{developerId}/sales/transactions/export' -Query @{ accept = 'json' }
}

# Alle Lizenzen. -AddonKey filtert auf eine App.
function Get-MpacLicenses {
    param([string]$AddonKey)
    $q = @{ accept = 'json' }
    if ($AddonKey) { $q.addon = $AddonKey }
    Invoke-Mpac -Path '/rest/3/reporting/developer-space/{developerId}/licenses/export' -Query $q
}

# Live Cloud-Pricing-Config einer App.
# STAND 2026-08-25: Im V3-Schema (76 Pfade) ist KEIN Ersatz fuer
# /rest/2/addons/{key}/pricing/cloud/live gefunden worden. Das ist ein
# "nicht gefunden", kein belegtes "existiert nicht".
# Bewusst harter Fehler statt stillem Aufruf eines toten Pfades.
function Get-MpacPricing {
    param([Parameter(Mandatory)][string]$AddonKey)
    throw "Get-MpacPricing ist nach der V3-Migration nicht verfuegbar: kein Pricing-Pfad im V3-Schema gefunden. Preise vorerst ueber das oeffentliche Listing oder das Vendor-UI pruefen."
}

# === ANALYSE-Helfer (auf den verifizierten Queries) =========================
# Unveraendert gegenueber der V2-Fassung: /export?accept=json liefert weiterhin
# ein BARES Array mit denselben Feldnamen (addonName, paymentStatus,
# purchaseDetails, vendorAmount, licenseType, status, cloudSiteHostname).

# Gesamteinnahme + Aufschluesselung pro App (Summe vendorAmount).
function Get-MpacEarnings {
    $raw  = Get-MpacTransactions
    $rows = foreach ($t in $raw) {
        foreach ($pd in @($t.purchaseDetails)) {
            [pscustomobject]@{
                App           = [string]$t.addonName
                PaymentStatus = [string]$t.paymentStatus
                SaleType      = [string]$pd.saleType
                PurchasePrice = [double]$pd.purchasePrice
                VendorAmount  = [double]$pd.vendorAmount
            }
        }
    }
    if (-not $rows) { Write-Warning 'Keine Transaktionen.'; return }
    $total = ($rows | Measure-Object VendorAmount -Sum).Sum
    $byApp = $rows | Group-Object App | ForEach-Object {
        [pscustomobject]@{
            App          = $_.Name
            Count        = $_.Count
            VendorAmount = [math]::Round((($_.Group | Measure-Object VendorAmount -Sum).Sum), 2)
        }
    } | Sort-Object VendorAmount -Descending
    [pscustomobject]@{
        TotalVendorAmount = [math]::Round([double]$total, 2)
        LineItems         = @($rows).Count
        ByApp             = $byApp
    }
}

# $0 disambiguieren: Lizenzen nach Typ/Status gruppieren.
function Get-MpacLicenseBreakdown {
    param([string]$AddonKey)
    $lics = Get-MpacLicenses -AddonKey $AddonKey
    $lics | Group-Object licenseType, status |
        Select-Object @{n='TypeStatus';e={$_.Name}}, Count |
        Sort-Object Count -Descending
}

# Sandbox/Non-Prod-Hosts flaggen (cloudSiteHostname-Heuristik aus KB).
function Get-MpacSandboxHosts {
    param([string]$AddonKey)
    $lics = Get-MpacLicenses -AddonKey $AddonKey
    $lics | Where-Object { $_.cloudSiteHostname -match '(-dev|-test|sandbox)' } |
        Select-Object addonKey, cloudSiteHostname, licenseType, status, appEdition |
        Sort-Object cloudSiteHostname
}

# === Report-Katalog =========================================================
# Verified = als funktionierender API-Pfad katalogisiert. Bei 404 den Pfad in
# der api-group-Seite gegenpruefen (Doku-Falle
# im Kopf dieser Datei beachten), NICHT raten.
$script:MpacKnownReports = @(
    @{ Name='transactions'; Verified=$true;  Path='/rest/3/reporting/developer-space/{developerId}/sales/transactions/export' }
    @{ Name='licenses';     Verified=$true;  Path='/rest/3/reporting/developer-space/{developerId}/licenses/export' }
    @{ Name='feedback';     Verified=$true;  Path='/rest/3/reporting/developer-space/{developerId}/feedback/details' }
    @{ Name='churn';        Verified=$true;  Path='/rest/3/reporting/developer-space/{developerId}/sales/metrics/churn' }
    @{ Name='conversions';  Verified=$true;  Path='/rest/3/reporting/developer-space/{developerId}/sales/metrics/conversion' }
    @{ Name='renewals';     Verified=$true;  Path='/rest/3/reporting/developer-space/{developerId}/sales/metrics/renewal' }
    # evaluations braucht einen Metrik-Namen im Pfad; welche Werte zulaessig sind,
    # ist ungeprueft -> bleibt unverifiziert, erster Call validiert.
    @{ Name='evaluations';  Verified=$false; Path='/rest/3/reporting/developer-space/{developerId}/evaluations/count' }
)

function Get-MpacReportCatalog { $script:MpacKnownReports | ForEach-Object { [pscustomobject]$_ } }

# Report per Name ziehen. -Force noetig fuer unverifizierte Pfade.
function Get-MpacReport {
    param(
        [Parameter(Mandatory)][string]$Name,
        [switch]$Force
    )
    $r = $script:MpacKnownReports | Where-Object Name -eq $Name | Select-Object -First 1
    if (-not $r) { throw "Unbekannter Report '$Name'. Verfuegbar: $(( $script:MpacKnownReports.Name) -join ', ')" }
    if (-not $r.Verified -and -not $Force) {
        throw "Report '$Name' Pfad ist NICHT für den konfigurierten Account verifiziert. Mit -Force trotzdem versuchen (validiert den Pfad)."
    }
    $q = @{}
    if ($r.Path -match '/export$') { $q.accept = 'json' }
    Invoke-Mpac -Path $r.Path -Query $q
}

Write-Host "mpac.ps1 geladen (V3-API). Funktionen: Get-MpacTransactions, Get-MpacLicenses, Get-MpacEarnings, Get-MpacLicenseBreakdown, Get-MpacSandboxHosts, Get-MpacReport, Get-MpacReportCatalog, Invoke-Mpac" -ForegroundColor Cyan
