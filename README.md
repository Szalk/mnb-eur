# MNB EURÓ Árfolyam Ellenőrző

> **Áfa tv. 80. § szerinti árfolyam-megfelelőség automatikus ellenőrzése bejövő EUR számlákhoz**

Ez az eszköz a könyvelők, adóellenőrök és belső auditorok munkáját segíti: automatikusan összveti a bejövő eurós számlákon alkalmazott devizaárfolyamokat a Magyar Nemzeti Bank (MNB) hivatalos árfolyamaival, az Általános forgalmi adóról szóló törvény **80. §-ának** előírásai szerint. Az ellenőrzés eredménye azonnal megjelenik a képernyőn, és szükség esetén Excelbe is exportálható.

---

## Tartalom

1. [Előkészítés – MNB adatok frissítése](#1-előkészítés--mnb-adatok-frissítése)
2. [Fájl feltöltése és oszlopok beállítása](#2-fájl-feltöltése-és-oszlopok-beállítása)
3. [Az elemzés elindítása](#3-az-elemzés-elindítása)
4. [Az eredmények értelmezése](#4-az-eredmények-értelmezése)
5. [Pénzügyi Korrekciós Elemzés táblázat](#5-pénzügyi-korrekciós-elemzés-táblázat)
6. [Gyors MNB árfolyam-kereső](#6-gyors-mnb-árfolyam-kereső)
7. [Excel export](#7-excel-export)
8. [Gyakorlati példák és teendők](#8-gyakorlati-példák-és-teendők)
9. [Jogi háttér összefoglalója](#9-jogi-háttér-összefoglalója)

---

## 1. Előkészítés – MNB adatok frissítése

Az eszköz a **Magyar Nemzeti Bank** webszolgáltatásából tölti le az euró hivatalos árfolyamait. A letöltés nem automatikus – az ellenőrzés elvégzése előtt egyszer frissíteni kell az adatokat.

**Teendő:**

1. Nyissa meg a program mappáját.
2. Kattintson duplán az **`mnb_frissites.bat`** fájlra.
3. Egy fekete ablak jelenik meg, amely letölti a legfrissebb MNB árfolyamokat (2021-től a mai napig). A folyamat általában néhány másodpercet vesz igénybe.
4. Amikor az ablak bezárul, a frissítés kész.

> **Mikor érdemes frissíteni?** Minden vizsgálat előtt, vagy ha az ellenőrzés során a felső sávban látható „Utolsó frissítés" dátum régebbi az ellenőrizni kívánt számlák dátumainál.

---

## 2. Fájl feltöltése és oszlopok beállítása

### Támogatott fájlformátumok

Az eszköz **Excel-fájlokat** fogad el (`.xlsx` és `.xls` kiterjesztéssel). A fájlnak tartalmaznia kell a bejövő számlákat soronként, ahol minden sor egy számlát jelöl.

### Fájl feltöltése

1. Nyissa meg az `index.html` fájlt egy böngészőben (pl. Chrome, Edge, Firefox).
2. A főoldalon megjelenik egy szürkés feltöltési terület: **„Húzza ide az Excel-fájlt, vagy kattintson a tallózáshoz"**.
3. Húzza rá a fájlt, vagy kattintson a területre a fájlböngészőhöz.
4. A sikeres feltöltés után megjelenik a fájl neve egy zöld sávban.

### Oszlopok beállítása (Konfiguráció)

Az eszköznek tudnia kell, melyik Excel-oszlop melyik adatot tartalmazza. Ehhez kattintson a jobb felső sarokban lévő **⚙ (fogaskerék)** ikonra.

Megnyílik az oszlop-konfiguráció panel:

| Mező neve | Mit kell ide beírni |
|---|---|
| **Számla száma** | Az oszlop neve, amely a számlaszámot tartalmazza |
| **Számla művelete** | Az oszlop neve a számla típusához (pl. „Számla művelete") |
| **Számla kelte** | Az oszlop neve a kiállítás dátumához |
| **Teljesítés dátuma** | Az oszlop neve a teljesítés napjához |
| **Számla pénzneme** | Az oszlop neve a devizanemhez (csak EUR sorok kerülnek elemzésre) |
| **EUR összeg** | Az oszlop neve az EUR-ban kifejezett nettó összeghez |
| **HUF összeg** | Az oszlop neve a forintban kifejezett nettó összeghez |
| **Alkalmazott árfolyam** | Az oszlop neve a számlán szereplő devizaárfolyamhoz |
| **Ügylet típusa** | Az oszlop neve, amely alapján az ügylettípus azonosítható |
| **Fejléc sora** | Hanyadik sorban van a fejléc (alapértelmezés: 5) |
| **Devizaszűrő** | Csak erre a devizanemre szűr az elemzés (alapértelmezés: EUR) |

> **Tipp:** Az oszlopneveket pontosan úgy kell beírni, ahogy az Excel-fejlécben szerepelnek (kis- és nagybetűk nem számítanak, de az ékezetek igen).

---

## 3. Az elemzés elindítása

1. A fájl feltöltése után kattintson az **„Elemzés indítása"** gombra.
2. A rendszer feldolgozza a fájlt (egy forgó ikon jelzi a folyamatot).
3. Az elemzés befejezése után az alábbi részek jelennek meg:

   - **Összefoglaló kártyák** – főbb statisztikák egy pillantásra
   - **Részletes táblázat** – minden EUR számla sora az ellenőrzés eredményével
   - **Pénzügyi Korrekciós Elemzés** – csak akkor jelenik meg, ha valódi hiba vagy számítási eltérés található

---

## 4. Az eredmények értelmezése

### Összefoglaló kártyák

Az elemzés elvégzése után öt összefoglaló kártya jelenik meg:

| Kártya | Mit mutat |
|---|---|
| **Összes számla** | Az elemzett EUR számlák száma |
| **Jogilag helyes** | Hány számla árfolyama felel meg az MNB előírásoknak |
| **Előző napi árfolyam** | Hány számlán alkalmaztak T−1 (előző munkanapi) árfolyamot – ez is törvényes |
| **Kérdéses / Hiányzó** | Hány számla igényel kézi felülvizsgálatot |
| **Pénzügyi eltérés** | A hibás sorok összesített HUF hatása |

---

### A jogi minősítés – mit jelent a zöld, kék, sárga és piros?

Minden számlasornál két jelzés látható egymás mellett:

#### 1. Forrás jelvény (bal oldali kis badge)

Ez mutatja meg, hogy a számlán szereplő árfolyam **melyik dátum MNB árfolyamával egyezik meg**, és milyen minőségben:

| Jelvény színe | Felirat | Jelentés |
|---|---|---|
| 🟢 **Sötétzöld** | Teljesítés · azonos nap | Az árfolyam pontosan egyezik a teljesítés napjának aktuális (T) MNB árfolyamával |
| 🟢 **Zöld** | Teljesítés · előző nap | Az árfolyam a teljesítés előtti munkanap (T−1) MNB árfolyamával egyezik – ez is törvényes |
| 🔵 **Kék** | Kiállítás · azonos nap | Kiállítás-alapú ügyleteknél (pl. közösségi, előleg) a kiállítás napjának T-árfolyamával egyezik |
| 🔵 **Kék** | Kiállítás · előző nap | Kiállítás-alapú ügyleteknél a T−1 árfolyammal egyezik – szintén törvényes |
| 🟡 **Sárga** | Teljesítés / Kiállítás · ±N nap | Az árfolyam nem az elvárt napra, hanem attól eltérő dátumra illeszthető |
| 🔴 **Piros** | Nincs egyezés | Az árfolyam egyetlen MNB-dátummal sem hozható összefüggésbe |

#### 2. Jogi értékelés (jobb oldali szöveges minősítés)

| Minősítés | Mit jelent | Teendő |
|---|---|---|
| ✅ **Jogilag helyes** | A számlán szereplő árfolyam megfelel az Áfa tv. 80. §-ának | Nincs teendő |
| ✅ **Jogilag helyes (eltéréssel)** | Az árfolyam törvényes, de a HUF összeg kerekítési eltérést tartalmaz | Ellenőrizze, hogy az eltérés valóban kerekítésbeli-e (néhány forint) |
| ⚠️ **Jogilag kérdéses** | Az árfolyam megtalálható az MNB adatokban, de nem a jogszabályilag előírt dátumhoz tartozik | Egyeztesse a szállítóval; mérlegelje, szükséges-e módosítás |
| ❌ **Nincs egyezés** | A számlán szereplő árfolyam nem azonosítható egyetlen MNB-adat alapján sem | Azonnali kivizsgálás szükséges |

---

### Sorok háttérszíne a táblázatban

A táblázat sorainak háttérszíne gyors vizuális tájékozódást nyújt:

| Háttérszín | Jelentés |
|---|---|
| ⬜ Fehér / Semleges | Jogilag helyes sor |
| 🟩 Zöld háttér | A számlán magasabb HUF összeg szerepel, mint az MNB árfolyamból számított (esetleges túlszámlázás) |
| 🟥 Piros háttér | A számlán alacsonyabb HUF összeg szerepel, mint az MNB árfolyamból számított (esetleges alulszámlázás) |
| 🟨 Sárga háttér | Minimális eltérés (kerekítési különbség, jellemzően néhány forint) |

---

### „Csak problémás sorok" szűrő

A táblázat felett található **„Csak problémás sorok"** gomb megnyomásával egyetlen kattintással elrejthetők a megfelelő sorok, és csak a kérdéses, illetve hibás tételek maradnak láthatók.

---

## 5. Pénzügyi Korrekciós Elemzés táblázat

Ha az elemzés során valódi hiba kerül azonosításra, a részletes táblázat **alatt** automatikusan megjelenik egy külön összefoglaló: a **Pénzügyi Korrekciós Elemzés**.

### Mikor jelenik meg ez a táblázat?

Kizárólag akkor, ha legalább egy számla az alábbi két feltétel valamelyikét teljesíti:

**A) Érvénytelen árfolyam** – A számlán alkalmazott árfolyam nem egyezik meg az ügylettípushoz előírt nap sem az aktuális (T), sem az előző munkanapi (T−1) MNB árfolyamával.

**B) Számítási hiba** – Az árfolyam törvényes (T vagy T−1 egyezés megvan), de a számlán szereplő forint összeg számtanilag nem következik belőle (az eltérés meghaladja a 0,01 Ft kerekítési tűréshatárt).

> **Fontos:** Ha egy számlán az előző munkanapi (T−1) árfolyamot alkalmazták, de a forint összeg helyesen van kiszámítva, **az a sor nem kerül a korrekciós táblázatba**. A T−1 árfolyam alkalmazása az Áfa tv. 80. §-a alapján jogszerű üzleti döntés.

### A korrekciós táblázat oszlopai

| Oszlop | Tartalom |
|---|---|
| **Számla azonosító** | A számlaszám és a hiba típusa (sárga: számítási hiba / piros: nincs egyezés / narancssárga: kérdéses árfolyam) |
| **Forrás EUR** | Az EUR összeg a számlán |
| **Számla HUF (forrás)** | A forint összeg a számlán |
| **Helyes MNB árfolyam** | A jogilag alkalmazandó MNB árfolyam, dátummal és típussal (T vagy T−1) |
| **Korrigált HUF összeg** | Az EUR × Helyes MNB árfolyam szorzatának eredménye |
| **Eltérés (HUF)** | A számla HUF összege és a korrigált HUF összeg különbsége |

### A lábléc sora – Teljes pénzügyi hatás

A táblázat alján megjelenik az összes eltérés összege. Ez azt mutatja, hogy az összes hibás számla együttesen mekkora forint különbséget eredményez:

- **Pozitív érték (piros):** összességében a cég többet fizetett/kapott a kelleténél
- **Negatív érték (zöld):** összességében a cég kevesebbet fizetett/kapott a kelleténél

---

## 6. Gyors MNB árfolyam-kereső

A fejlécben lévő **🔍 (kereső)** ikonra kattintva megnyílik a Gyors Árfolyam-kereső panel. Ez lehetővé teszi, hogy bármely dátumra lekérdezze az MNB EUR árfolyamot anélkül, hogy Excelbe kellene böngésznie.

### Hogyan működik?

1. Írja be a keresett dátumot az ÉÉÉÉ-HH-NN formátumban (pl. `2024-03-15`).
2. Kattintson a **„Keresés"** gombra, vagy nyomjon Entert.

### Mit mutat az eredmény?

**Munkanapra keresve:**

Az eszköz megjeleníti **mindkét** jogilag érvényes árfolyamot egymás mellett:

| Megjelenítés | Mit jelent |
|---|---|
| **T – Aktuális napi árfolyam** | Az adott munkanapon közzétett MNB árfolyam |
| **T−1 – Előző munkanapi árfolyam** | Az előző munkanapon közzétett MNB árfolyam |

Mindkét érték zöld kerettel és „Jogilag elfogadható" jelzéssel szerepel, mivel az Áfa tv. 80. §-a szerint munkanapon bármelyik alkalmazható.

**Hétvégére vagy munkaszüneti napra keresve:**

Hétvégén és munkaszüneti napokon az MNB nem tesz közzé új árfolyamot. Ilyenkor az eszköz sárga háttérrel jelzi, hogy az utolsó érvényes árfolyam melyik munkanapra datálódik, és ez az **egyetlen** jogszerűen alkalmazható érték.

---

## 7. Excel export

### A korrekciós elemzés exportálása

A **Pénzügyi Korrekciós Elemzés** táblázat fejlécénél megjelenik egy **„Exportálás Excelbe"** gomb. Erre kattintva a rendszer letölt egy `.xlsx` fájlt, amely tartalmazza:

- Az összes problémás számla adatait (számlaszám, típus, EUR összeg, számla HUF, helyes árfolyam, korrigált HUF, eltérés)
- A lábléc sorban az összesített pénzügyi hatást
- Az összes szám **vesszővel** mint tizedes elválasztóval (magyar könyvelési szoftverekkel kompatibilis)

### A részletes táblázat exportálása

A részletes táblázat felett az eszköz exportálási lehetőségeket kínál (CSV formátum), amellyel a teljes elemzés eredménye menthető a saját könyvelési rendszerbe való feldolgozáshoz.

---

## 8. Gyakorlati példák és teendők

### 1. példa – Munkanapi teljesítés, aktuális árfolyam alkalmazva ✅

**Helyzet:** Egy 2024. március 12-én (kedd) teljesített számla forint összegét az aznapi MNB EUR árfolyammal (pl. 392,45 HUF/EUR) számolták.

**Mit mutat az eszköz:**
- Forrás jelvény: 🟢 **Sötétzöld** – „Teljesítés · azonos nap"
- Jogi értékelés: ✅ **Jogilag helyes**
- A sor nem kerül a korrekciós táblázatba

**Teendő:** Nincs teendő. Az árfolyam alkalmazása megfelel a jogszabályi előírásoknak.

---

### 2. példa – Munkanapi teljesítés, előző napi árfolyam alkalmazva ✅

**Helyzet:** Egy 2024. március 12-én (kedd) teljesített számla forint összegét a **március 11-ei** (hétfői) MNB árfolyammal számolták. A szállító vállalat számviteli rendszere alapesetben az előző napi árfolyamot alkalmazza.

**Mit mutat az eszköz:**
- Forrás jelvény: 🟢 **Zöld** – „Teljesítés · előző nap"
- Jogi értékelés: ✅ **Jogilag helyes**
- A sor **nem** kerül a korrekciós táblázatba

**Teendő:** Nincs teendő. Az Áfa tv. 80. §-a alapján munkanapon mind az aktuális (T), mind az előző munkanapi (T−1) MNB árfolyam jogszerűen alkalmazható. Ez üzleti döntés kérdése, nem hiba.

---

### 3. példa – Hétvégi teljesítés ✅

**Helyzet:** Egy 2024. március 16-án (szombat) teljesített számlán az MNB március 15-ei (pénteki) árfolyamát alkalmazták.

**Mit mutat az eszköz:**
- Forrás jelvény: 🟢 **Zöld** – „Teljesítés · azonos nap" (a péntek az utolsó érvényes munkanap)
- Jogi értékelés: ✅ **Jogilag helyes**

**Teendő:** Nincs teendő. Hétvégén az MNB nem tesz közzé új árfolyamot; az utolsó munkanap (péntek) árfolyama az egyetlen jogszerűen alkalmazható érték.

---

### 4. példa – Számítási hiba törvényes árfolyam mellett ⚠️

**Helyzet:** A számla EUR összege 5 000 EUR, az alkalmazott árfolyam 392,45 HUF/EUR (ez pontosan egyezik az MNB adatával), de a számlán szereplő HUF összeg 1 963 800 Ft helyett 1 960 000 Ft.

**Mit mutat az eszköz:**
- Forrás jelvény: 🟢 **Zöld** – az árfolyam helyes
- Jogi értékelés: ✅ **Jogilag helyes (eltéréssel)**
- A sor **megjelenik** a korrekciós táblázatban: „Számítási hiba" típusú problémaként
- Eltérés: +3 800 Ft (alulszámlázás)

**Teendő:** Ellenőrizze a számlakibocsátó számítási módszerét. Ha az eltérés nem kerekítési különbségből ered, **módosító számla kiállítása** válhat szükségessé.

---

### 5. példa – Érvénytelen árfolyam ❌

**Helyzet:** Egy számla EUR összege 2 000 EUR, de a számlán szereplő árfolyam (pl. 401,12 HUF/EUR) egyetlen MNB-dátum árfolyamával sem egyezik meg – sem az előírt napon, sem az előző munkanap.

**Mit mutat az eszköz:**
- Forrás jelvény: 🔴 **Piros** – „Nincs egyezés"
- Jogi értékelés: ❌ **Nincs egyezés**
- A sor megjelenik a korrekciós táblázatban: „Nincs egyezés" típusú problémaként
- A korrekciós táblázat megmutatja, mekkora lenne a helyes összeg az MNB árfolyam alapján, és mekkora az eltérés

**Teendő:** A számlán szereplő árfolyam forrása ismeretlen (pl. kereskedelmi bank árfolyama, saját számítás). Egyeztessen a szállítóval és kérjen **módosító számlát** a jogszerű MNB árfolyamon alapuló összeggel.

---

### 6. példa – Közösségen belüli termékbeszerzés (KB) ügylettípus 🔵

**Helyzet:** Egy közösségen belüli termékbeszerzésnél (KB) a rendszer a **kiállítás napját** veszi alapul (az Áfa tv. 80. §-a alapján), nem a teljesítés napját. A számlán a kiállítás napjának T-árfolyamát alkalmazták.

**Mit mutat az eszköz:**
- Forrás jelvény: 🔵 **Kék** – „Kiállítás · azonos nap"
- Jogi értékelés: ✅ **Jogilag helyes**

**Teendő:** Nincs teendő. Az eszköz figyelembe veszi az ügylettípus-specifikus szabályokat: KB, előleg, időszakos elszámolás és fordított adózás esetén a kiállítás napja az irányadó, nem a teljesítés napja.

---

## 9. Jogi háttér összefoglalója

Az eszköz az **Általános forgalmi adóról szóló 2007. évi CXXVII. törvény 80. §-a** alapján ellenőriz. Az alábbi szabályok épülnek be az elemzési logikába:

### Az irányadó dátum ügylettípusonként

| Ügylettípus | Irányadó dátum az árfolyam meghatározásához |
|---|---|
| Általános eset | A teljesítés napja |
| Közösségen belüli termékbeszerzés (KB) | A számla kiállításának napja |
| Előleg | A jóváírás / kézhezvétel napja (= kiállítás napja) |
| Fordított adózás | A kiállítás napja, de legfeljebb a teljesítés hónapját követő hónap 15. napja |
| Időszakos elszámolás | A számla kiállításának napja |

### A kettős árfolyam szabálya (T és T−1)

Az MNB minden munkanapon közzéteszi az aktuális árfolyamot (T). Az Áfa tv. 80. §-a alapján **mindkét** alábbi árfolyam jogszerűen alkalmazható az adott munkanapra:

- **T – az adott munkanap árfolyama** (pl. kedd déli MNB közlemény)
- **T−1 – az előző munkanap árfolyama** (pl. hétfői MNB közlemény)

A vállalkozás szabadon dönthet arról, melyiket alkalmazza, feltéve, hogy következetesen jár el. Az eszköz **mindkét** lehetőséget elfogadja, és kizárólag akkor jelez hibát, ha a számlán alkalmazott árfolyam egyik lehetőséggel sem egyezik.

### Hétvégékre és munkaszüneti napokra vonatkozó szabály

Hétvégéken és munkaszüneti napokon az MNB nem állapít meg új árfolyamot. Ilyen napon teljesített ügyleteknél az **utolsó érvényes munkanapra** megállapított MNB árfolyamot kell alkalmazni – ez az egyetlen jogszerű lehetőség.

---

*Az eszköz tájékoztató jellegű segédeszköz. Az itt megjelenő eredmények nem helyettesítik az adótanácsadói vagy könyvvizsgálói szakvéleményt. Kétes esetekben minden esetben kérje szakértő segítségét.*
