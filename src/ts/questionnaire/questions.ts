// Questionnaire content. Source of truth: docs/kwestionariusz-prototyp.html (approved by the owner).
// Do not change questions or "ciekawostki" (tips) without the owner's approval – see CLAUDE.md.
//
// Option syntax: "emoji|Label", suffix "!x" = exclusive option (clears the others), "!o" = "other" with a text field.
// Tips are trusted, hand-written HTML.

/** Grammatical form chosen in the first question. */
export interface Ctx {
  male: boolean;
  neutral: boolean;
  /** Picks the masculine, feminine or neutral variant of a phrase. */
  g: (m: string, f: string, n?: string) => string;
}

export type Txt = string | ((c: Ctx) => string);
type Opts = string[] | ((c: Ctx) => string[]);

interface Base {
  s: string;
  id: string;
  q: Txt;
  hint?: Txt;
  tip?: string;
}
export type ChoiceQuestion = Base & { type: 'single' | 'multi'; opts: Opts };
export type TextQuestion = Base & { type: 'text'; ph?: string; none?: string };
export type FieldsQuestion = Base & {
  type: 'fields';
  fields: [key: string, label: string, input: string, unit?: string][];
};
export type WaistQuestion = Base & { type: 'waist' };
export type MatrixQuestion = Base & { type: 'matrix'; mode: 'single' | 'multi'; rows: string[]; cols: string[] };
export type ScaleQuestion = Base & { type: 'scale'; lo: string; hi: string; faces: string[] };
export type Question = ChoiceQuestion | TextQuestion | FieldsQuestion | WaistQuestion | MatrixQuestion | ScaleQuestion;

export type Answers = Record<string, unknown>;

export const SEX_MALE = 'Mężczyzna';
export const SEX_NEUTRAL = 'Inaczej / wolę formy neutralne';

export function ctxFor(answers: Answers): Ctx {
  const male = answers.plec === SEX_MALE;
  const neutral = answers.plec === SEX_NEUTRAL;
  return { male, neutral, g: (m, f, n) => (male ? m : neutral && n != null ? n : f) };
}

export const resolve = <T>(x: T | ((c: Ctx) => T), c: Ctx): T =>
  typeof x === 'function' ? (x as (c: Ctx) => T)(c) : x;

export interface Option {
  e: string;
  t: string;
  /** exclusive */
  ex: boolean;
  /** "other" with free text */
  ot: boolean;
}

export function parseOption(raw: string): Option {
  let s = raw;
  let ex = false;
  let ot = false;
  if (s.endsWith('!x')) {
    ex = true;
    s = s.slice(0, -2);
  }
  if (s.endsWith('!o')) {
    ot = true;
    s = s.slice(0, -2);
  }
  const [e = '', t = ''] = s.split('|');
  return { e, t, ex, ot };
}

/* prettier-ignore */
export const QUESTIONS: Question[] = [
  // NA START
  {s:'Na start',id:'plec',type:'single',q:'Jak mam się do Ciebie zwracać?',opts:['👩|Kobieta','👨|Mężczyzna','✨|Inaczej / wolę formy neutralne']},
  {s:'Na start',id:'dane',type:'fields',q:'Kilka podstawowych danych',fields:[['imie','Imię','text'],['wiek','Wiek','number','lat'],['wzrost','Wzrost','number','cm'],['masa','Masa ciała','number','kg']]},
  {s:'Na start',id:'talia',type:'waist',tip:"<div class=\"tip\"><span class=\"te\">📏</span><div><p><b class=\"tl\">Czy wiesz, że…</b> dobrą wskazówką dla zdrowia jest talia <b>mniejsza niż połowa wzrostu</b>? Przy 168 cm to poniżej 84 cm. Tłuszcz gromadzący się na brzuchu, w tym ten wokół narządów wewnętrznych (tzw. tłuszcz trzewny), wiąże się z ryzykiem cukrzycy typu 2, nadciśnienia i chorób serca. W badaniu zwykły centymetr wskazywał to ryzyko równie dobrze jak pomiar tłuszczu trzewnego w rezonansie.</p><p><b>Zalecany obwód talii:</b> poniżej <b>80 cm u kobiet</b> i poniżej <b>94 cm u mężczyzn</b>.</p><p class=\"src\">Źródło: <a href=\"https://www.nice.org.uk/news/articles/keep-the-size-of-your-waist-to-less-than-half-of-your-height-nice--recommends\" target=\"_blank\" rel=\"noopener\">NICE 2022</a>; <a href=\"https://www.utupub.fi/items/70306652-8ac2-46cd-8657-82b36d1d1de1/full\" target=\"_blank\" rel=\"noopener\">Ruano i in., Nutrition, Metabolism and Cardiovascular Diseases 2024</a>; <a href=\"https://research.vu.nl/en/publications/waist-circumference-as-a-vital-sign-in-clinical-practice-a-consen/\" target=\"_blank\" rel=\"noopener\">Ross i in., Nature Reviews Endocrinology 2020</a>; <a href=\"https://who.int/publications/i/item/9789241501491\" target=\"_blank\" rel=\"noopener\">WHO 2008</a>; <a href=\"https://www.sciensano.be/en/node/74937\" target=\"_blank\" rel=\"noopener\">Sciensano</a></p></div></div>",q:'Obwód talii'},
  {s:'Na start',id:'cel',type:'multi',q:'Z czym przychodzisz?',hint:'Zaznacz wszystko, co pasuje.',opts:['⚖️|Chcę schudnąć','🍽️|Chcę przytyć','💪|Chcę zmniejszyć tłuszcz i zbudować mięśnie','🩺|Dieta przy chorobie','🍽️|Uporządkować jedzenie','🧠|Spokojniejsza relacja z jedzeniem','⚡|Więcej energii','🌱|Zdrowsze nawyki','✍️|Inne!o']},
  {s:'Na start',id:'waga',type:'single',q:'Jak zmieniała się Twoja waga w ostatnim roku?',opts:['➖|Jest stabilna','📉|Spadła o ponad 3 kg','📈|Wzrosła o ponad 3 kg','🎢|Waha się w górę i w dół','🤷|Nie wiem','✍️|Inne!o']},
  // ZDROWIE
  {s:'Zdrowie',id:'choroby',type:'multi',q:'Czy masz zdiagnozowane któreś z tych schorzeń albo jesteś w trakcie diagnozy?',hint:'Zaznacz też te, które są dopiero diagnozowane.',opts:(c)=>['🩸|Insulinooporność / stan przedcukrzycowy','💉|Cukrzyca','🦋|Niedoczynność tarczycy / Hashimoto','❤️|Nadciśnienie','🧈|Podwyższony cholesterol',...(c.male?[]:['🌸|PCOS / zaburzenia hormonalne']),'🫃|Problemy jelitowe (IBS, wzdęcia)','🔥|Refluks / zgaga','🩹|Anemia','✍️|Inne!o','✅|Nie mam żadnych!x']},
  {s:'Zdrowie',id:'objawy',type:'multi',q:'Czy często masz któreś z tych objawów?',hint:'Zaznacz wszystko, co zdarza się regularnie.',opts:(c)=>['😵|Osłabienie, zawroty głowy','🥱|Ciągłe zmęczenie','😴|Senność po posiłku','🥶|Często jest mi zimno','💇|Wypadanie włosów, łamliwe paznokcie','🌵|Sucha skóra','🦶|Obrzęki (np. nóg, twarzy)','💓|Kołatanie serca','😓|Nadmierne pocenie się','✋|Drżenie rąk lub silny głód, gdy długo nie jem','🤕|Bóle głowy','🎈|Wzdęcia, bóle brzucha','🔥|Zgaga','🧠|Problemy z koncentracją','😔|Obniżony nastrój',...(c.male?[]:['📅|Nieregularne miesiączki']),'✍️|Inne!o','🌿|Nie mam takich objawów!x']},
  {s:'Zdrowie',id:'leki',type:'text',q:'Jakie leki i suplementy przyjmujesz?',hint:(c)=>'Nazwa i dawka, jeśli pamiętasz.'+(c.male?'':' Wpisz też antykoncepcję hormonalną.'),ph:'np. Euthyrox 50 µg rano, witamina D 2000 j.',none:'Nie przyjmuję żadnych'},
  {s:'Zdrowie',id:'alergie',type:'multi',q:'Czy masz alergie lub nietolerancje pokarmowe albo gorzej się czujesz po którymś produkcie?',hint:'Zaznacz też produkty, po których zauważasz objawy (np. wzdęcia, ból brzucha, wysypkę, senność).',opts:['🥛|Laktoza','🧀|Białko mleka krowiego','🌾|Gluten / celiakia','🥜|Orzeszki ziemne','🌰|Orzechy','🥚|Jaja','🐟|Ryby','🦐|Skorupiaki, owoce morza','🫘|Soja','🌿|Seler','🟡|Gorczyca','⚪|Sezam','🍷|Siarczyny','🍎|Fruktoza','🍯|Histamina','🧅|FODMAP (np. cebula, czosnek)','✍️|Inne!o','✅|Nie mam!x']},
  {s:'Zdrowie',id:'wyproz',type:'single',q:'Jak często się wypróżniasz?',opts:['🗓️|Codziennie','📆|Co 2–3 dni','🐢|Rzadziej niż co 3 dni','🔀|Nieregularnie','💧|Często mam biegunki','✍️|Inne!o']},
  {s:'Zdrowie',id:'sen',tip:"<div class=\"tip\"><span class=\"te\">😴</span><div><p><b class=\"tl\">Ciekawostka</b> Krótka noc odbija się na talerzu. Po niewyspaniu jemy następnego dnia średnio <b>o ok. 385 kcal więcej</b>, czyli mniej więcej tyle, ile w 4–5 kromkach chleba.</p><p class=\"src\">Źródło: <a href=\"https://www.kcl.ac.uk/archive/news/kings/newsrecords/2016/11%20november-/sleep-deprivation-may-cause-people-to-eat-more-calories\" target=\"_blank\" rel=\"noopener\">Al Khatib i in., European Journal of Clinical Nutrition 2017</a></p></div></div>",type:'single',q:'Ile zwykle śpisz?',opts:['🥱|Mniej niż 5 h','😪|5–6 h','😴|7–8 h','🛌|Ponad 8 h','✍️|Inne!o']},
  {s:'Zdrowie',id:'stres',type:'scale',q:'Jaki jest Twój poziom stresu na co dzień?',lo:'Spokój',hi:'Ogromny stres',faces:['😌','🙂','😐','😟','😫']},
  {s:'Zdrowie',id:'praca_ruch',type:'multi',q:'Jaki jest charakter Twojej pracy?',hint:'Zaznacz wszystko, co pasuje.',opts:['🪑|Siedząca','🔄|Trochę siedzę, trochę chodzę','🧍|Stojąca','🚶|W ruchu (np. kurier, kelner)','🧱|Fizyczna','🏠|Zdalna','🌙|Zmianowo / na noce','🎓|Uczę się','🌴|Nie pracuję!x','✍️|Inne!o']},
  {s:'Zdrowie',id:'ruch',type:'single',q:'Ile się ruszasz poza pracą?',hint:'Jeśli liczysz kroki, wybierz ostatnią opcję i wpisz średnią liczbę.',opts:['🛋️|Prawie wcale','🚶|Spacery, lekki ruch','🏃|Trening 1–2× w tygodniu','🏋️|Trening 3× w tygodniu lub więcej','👣|Liczę kroki – wpiszę średnią dziennie!o']},
  {s:'Zdrowie',id:'badania',type:'single',q:(c)=>c.g('Kiedy ostatnio robiłeś badania krwi?','Kiedy ostatnio robiłaś badania krwi?','Kiedy były Twoje ostatnie badania krwi?'),hint:'Jeśli masz wyniki, wyślij mi je razem z tym kwestionariuszem (zdjęcie lub PDF).',opts:(c)=>['🧪|W ostatnich 3 miesiącach','📋|3–12 miesięcy temu','⏳|Ponad rok temu',c.g('🤷|Nie pamiętam / nie robiłem','🤷|Nie pamiętam / nie robiłam','🤷|Nie pamiętam / jeszcze nie było'),'✍️|Inne!o']},
  // UŻYWKI I NAPOJE
  {s:'Używki',id:'alkohol',type:'single',q:'Jak często pijesz alkohol?',opts:['🍻|Kilka razy w tygodniu','🍷|Około raz w tygodniu','🥂|2–3 razy w miesiącu','🍸|Około raz w miesiącu','🌙|Rzadziej','🚫|Nie piję','✍️|Inne!o']},
  {s:'Używki',id:'papierosy',type:'single',q:'Czy palisz?',opts:['🚭|Nie palę','🌫️|Okazjonalnie','🚬|Codziennie','💨|E-papierosy / podgrzewacze','✍️|Inne!o']},
  {s:'Używki',id:'kawa',type:'single',q:'Ile kaw lub energetyków dziennie?',opts:['🫖|Żadnej','☕|1','☕☕|2–3','⚡|4 lub więcej','✍️|Inne!o']},
  {s:'Używki',id:'slodkie',type:'single',q:'Jak często pijesz słodkie napoje lub soki?',opts:['🥤|Codziennie','🧃|Kilka razy w tygodniu','🍹|Rzadko','💧|Nie piję','✍️|Inne!o']},
  {s:'Używki',id:'woda',tip:"<div class=\"tip\"><span class=\"te\">💧</span><div><p><b class=\"tl\">Ciekawostka</b> Ok. <b>2 litry dziennie dla kobiet</b> i <b>2,5 litra dla mężczyzn</b>, i to razem z wodą z jedzenia, więc zupa czy arbuz też się liczą. W gabinecie często liczy się 30–35 ml na kilogram: przy 60 kg wychodzi ok. 7–8 szklanek. Przy wyższej masie ciała ten przelicznik zawyża wynik, więc liczy się wtedy inaczej.</p><p class=\"src\">Źródło: <a href=\"https://www.efsa.europa.eu/en/press/news/nda100326\" target=\"_blank\" rel=\"noopener\">EFSA 2010</a>; <a href=\"https://pub.norden.org/nord2023-003/fluid-and-water-balance.html\" target=\"_blank\" rel=\"noopener\">Nordic Nutrition Recommendations 2023</a>; <a href=\"https://www.health.qld.gov.au/__data/assets/pdf_file/0022/144175/est-req.pdf\" target=\"_blank\" rel=\"noopener\">Queensland Health</a></p></div></div>",type:'single',q:'Ile wody wypijasz dziennie?',opts:['💧|Mniej niż 1 l','💧💧|1–1,5 l','💧💧💧|1,5–2 l','🌊|Ponad 2 l','✍️|Inne!o']},
  // TWÓJ DZIEŃ
  {s:'Twój dzień',id:'posilki',type:'single',q:'Ile posiłków zwykle jesz?',opts:['1️⃣|1–2','3️⃣|3','4️⃣|4','5️⃣|5 lub więcej','🔀|Bardzo różnie!o']},
  {s:'Twój dzień',id:'posilki_chce',type:'single',q:'Ile posiłków chcesz jeść w ciągu dnia?',hint:'Tak, żeby pasowało do Twojego dnia.',opts:['2️⃣|2','3️⃣|3','4️⃣|4','5️⃣|5','🤷|Nie wiem, doradź mi','✍️|Inne!o']},
  {s:'Twój dzień',id:'sniadanie',type:'single',q:'Czy jesz śniadania i kiedy?',opts:['🌅|Zaraz po przebudzeniu','⏰|1–2 godziny po wstaniu','💼|Później, np. w pracy','☕|Rano tylko kawa, jem dopiero później','🚫|Nie jem śniadań','✍️|Inne!o']},
  {s:'Twój dzień',id:'sniadanie_czas',type:'single',q:'Ile masz rano czasu na przygotowanie śniadania?',opts:['⚡|Prawie wcale – coś gotowego lub do zabrania','⏱️|Do 5 minut','🍳|5–15 minut','🥞|Ponad 15 minut','🗓️|Różnie, zależy od dnia','✍️|Inne!o']},
  {s:'Twój dzień',id:'godziny',type:'fields',q:'Twój typowy dzień',hint:'Wystarczy w przybliżeniu.',fields:[['wstaje','Wstaję ok.','time'],['pierwszy','Pierwszy posiłek ok.','time'],['spac','Kładę się ok.','time']]},
  {s:'Twój dzień',id:'podgrzac',type:'multi',q:'Czy w pracy lub szkole możesz podgrzać jedzenie?',hint:'Zaznacz, czym dysponujesz.',opts:['📦|Mikrofala','🍞|Toster','♨️|Piekarnik','🫖|Czajnik','✍️|Inne!o','❌|Nie mam takiej możliwości!x','🏡|Jem w domu!x']},
  {s:'Twój dzień',id:'gotuje',type:'single',q:'Kto u Ciebie gotuje?',hint:'W następnym pytaniu zaznaczysz, dla ilu osób.',opts:(c)=>[c.g('🧑‍🍳|Gotuję sam','👩‍🍳|Gotuję sama','🧑‍🍳|Gotuję samodzielnie'),'👫|Razem z partnerem / rodziną','🍲|Ktoś gotuje za mnie','🥡|Jem głównie na mieście / catering','✍️|Inne!o']},
  {s:'Twój dzień',id:'osoby',type:'single',q:'Dla ilu osób gotujesz (lub ktoś gotuje)?',hint:'Ile osób je te same posiłki, łącznie z Tobą.',opts:['🙋|Tylko ja','👥|2 osoby','👨‍👩‍👦|3 osoby','👨‍👩‍👧‍👦|4 osoby','🏘️|5 lub więcej','✍️|Inne!o']},
  {s:'Twój dzień',id:'sprzet',type:'multi',q:'Jaki sprzęt masz w kuchni?',hint:'Zaznacz wszystko, co masz.',opts:['🍹|Blender ręczny','🥤|Blender kielichowy','🤖|Robot kuchenny','📦|Mikrofala','🍟|Airfryer','🥧|Piekarnik','🍞|Toster','🧇|Gofrownica','🍖|Opiekacz / grill','🥦|Parowar (do gotowania na parze)','✍️|Inne!o']},
  {s:'Twój dzień',id:'czas',type:'single',q:'Ile czasu dziennie możesz poświęcić na gotowanie?',opts:['⚡|Do 15 min','⏱️|15–30 min','🕐|30–60 min','🍳|Ponad godzinę','✍️|Inne!o']},
  {s:'Twój dzień',id:'zapas',type:'single',q:'Czy możesz gotować na 2 dni do przodu?',opts:['👍|Tak, chętnie','🤏|Czasami','🌿|Wolę świeże codziennie','✍️|Inne!o']},
  {s:'Twój dzień',id:'sklepy',type:'multi',q:'Gdzie najczęściej robisz zakupy?',opts:['🐞|Biedronka','🛒|Lidl','🏬|Kaufland','🛍️|Auchan','🧺|Carrefour','🦕|Dino','🏪|Netto','🏷️|Aldi','🌼|Stokrotka','🐸|Żabka','🥕|Bazarek / warzywniak','📱|Zakupy online','✍️|Inne!o']},
  // SMAKI I ZMYSŁY
  {s:'Smaki i zmysły',id:'lubi',type:'multi',q:'Co lubisz jeść najbardziej?',hint:'Zaznacz wszystko, co lubisz. W „Inne” wpisz swoje ulubione produkty i dania.',opts:['😋|Wszystko!x','🍔|Fast food (burgery, pizza, frytki)','🥤|Słodkie napoje','🍫|Słodycze','🥨|Słone, chrupiące przekąski','🧀|Ser','🥖|Pieczywo','🍗|Mięso, drób','🐟|Ryby','🥚|Jajka','🥛|Nabiał (jogurt, twaróg)','🍝|Makaron, ryż, kasze','🥦|Warzywa','🍎|Owoce','🫘|Strączki','🥜|Orzechy','🍲|Zupy','🧀|Dania zapiekane','🍳|Dania smażone','🥘|Duszone, gulasze','🍗|Pieczone','🔥|Grillowane','♨️|Gotowane na parze','🥗|Sałatki','🥪|Kanapki, wrapy','🫕|Dania jednogarnkowe','🥣|Owsianki, kasze na słodko','✍️|Inne!o']},
  {s:'Smaki i zmysły',id:'nielubi',type:'multi',q:(c)=>c.g('Czego nie lubisz albo najmniej chciałbyś jeść?','Czego nie lubisz albo najmniej chciałabyś jeść?','Czego nie lubisz albo najmniej chcesz jeść?'),hint:'Zaznacz wszystko, czego nie lubisz. W „Inne” wpisz konkretnie, jakich (np. które warzywa, owoce czy kasze).',opts:['🥦|Niektóre warzywa','🍎|Niektóre owoce','🌾|Kasze','🍚|Ryż','🍝|Makaron','🥔|Ziemniaki','🫘|Strączki','🥜|Orzechy','🐟|Ryby','🍗|Mięso, drób','🥚|Jajka','🥛|Nabiał (jogurt, twaróg)','🧀|Ser','🥖|Pieczywo','🌶️|Niektóre przyprawy','🍲|Zupy','🥗|Sałatki','🥣|Owsianki, kasze na słodko','♨️|Gotowane na parze','🥘|Duszone, gulasze','🍗|Pieczone','🔥|Grillowane','🧀|Dania zapiekane','🍳|Dania smażone','🫕|Dania jednogarnkowe','🥪|Kanapki, wrapy','🥨|Słone, chrupiące przekąski','🍫|Słodycze','🥤|Słodkie napoje','🍔|Fast food (burgery, pizza, frytki)','✍️|Inne!o','👌|Jem prawie wszystko!x']},
  {s:'Smaki i zmysły',id:'przyprawy_nie',type:'text',q:'Jakich przypraw nie lubisz?',hint:'Wpisz wszystkie, których nie chcesz w posiłkach.',ph:'np. kolendra, kmin rzymski, curry, czosnek',none:'Lubię wszystkie przyprawy'},
  {s:'Smaki i zmysły',id:'smaki',type:'matrix',mode:'multi',q:'Na jakie smaki masz ochotę o różnych porach?',hint:'Przy każdej porze zaznacz, co lubisz.',rows:['Rano','W południe','Wieczorem','Na przekąskę'],cols:['🍯|Słodki','🧂|Słony','🍋|Kwaśny','🌶️|Ostry','🍄|Wytrawny','🥛|Łagodny','🤷|Bez różnicy']},
  {s:'Smaki i zmysły',id:'porcje',type:'matrix',mode:'single',q:'Jakie porcje wolisz w ciągu dnia?',rows:['Śniadanie','Obiad','Kolacja','Przekąski'],cols:['s|Mała','m|Średnia','l|Duża','🤷|Bez różnicy']},
  {s:'Smaki i zmysły',id:'kons_lubi',type:'multi',q:'Jakie konsystencje lubisz?',opts:['😋|Wszystkie!x','🥨|Chrupiące','🍮|Kremowe, gładkie','🍉|Soczyste','🧈|Miękkie, rozpływające się','🍬|Ciągnące, gumowate','🍚|Sypkie (ryż, kasza)','🥣|Gęste (owsianka, gulasz)','🍓|Kawałki w czymś gładkim (jogurt z owocami)','✍️|Inne!o']},
  {s:'Smaki i zmysły',id:'kons_nie',type:'multi',q:'Jakich konsystencji nie lubisz?',opts:['🦪|Śliskie (np. gotowana cebula)','🥩|Żylaste, włókniste','🥔|Papkowate','🫘|Z grudkami','🥨|Twarde, chrupiące','🍬|Ciągnące, gumowate','🍓|Kawałki w czymś gładkim','✍️|Inne!o','👌|Nic mi nie przeszkadza!x']},
  {s:'Smaki i zmysły',id:'temp',tip:"<div class=\"tip\"><span class=\"te\">☕</span><div><p><b class=\"tl\">Ciekawostka</b> W medycynie chińskiej ciepłe śniadanie ma „rozgrzewać” trawienie na cały dzień. Nauka nie potwierdziła tego wprost, ale ciepły napój rzeczywiście pobudza żołądek do pracy, a w badaniach z pacjentami po operacjach ciepła woda pomagała jelitom szybciej ruszyć.</p><p class=\"src\">Źródło: <a href=\"https://d-nb.info/1177661683/34\" target=\"_blank\" rel=\"noopener\">Fujihira i in., European Journal of Nutrition 2019</a>; <a href=\"https://pubmed.ncbi.nlm.nih.gov/27684632/\" target=\"_blank\" rel=\"noopener\">badanie po cholecystektomii (PubMed)</a>; <a href=\"https://turkiyeklinikleri.com/article/en-determination-of-the-effect-of-starting-oral-feeding-with-warm-water-on-bowel-functions-after-thoracotomy-a-randomized-controlled-trial-106736.html\" target=\"_blank\" rel=\"noopener\">badanie po torakotomii</a></p></div></div>",type:'single',q:'Jakie dania wolisz?',opts:['🍲|Ciepłe','🥗|Zimne','🔄|Rano ciepłe, później zimne','🤷|Bez różnicy','✍️|Inne!o']},
  {s:'Smaki i zmysły',id:'talerz',type:'single',q:'Na talerzu wolisz…',opts:['🥘|Wszystko wymieszane (gulasz, sałatka)','🍱|Składniki osobno, żeby się nie stykały','🤷|Bez różnicy','✍️|Inne!o']},
  {s:'Smaki i zmysły',id:'nowosci',type:'single',q:'Jak podchodzisz do nowych smaków?',opts:['🤩|Uwielbiam próbować','🙂|Spróbuję, jeśli wygląda znajomo','🏠|Wolę to, co znam','😬|Nowe potrawy mnie stresują','✍️|Inne!o']},
  // TY I JEDZENIE
  {s:'Ty i jedzenie',id:'kiedy',type:'multi',q:'Po jedzenie sięgasz najczęściej, gdy…',hint:'Zaznacz wszystko, co się zdarza.',opts:(c)=>[c.g('🍽️|Jestem głodny','🍽️|Jestem głodna','🍽️|Czuję głód'),'😰|Się stresuję','🥱|Się nudzę','😔|Jest mi smutno','🎉|Chcę się nagrodzić',c.g('😴|Jestem zmęczony','😴|Jestem zmęczona','😴|Czuję zmęczenie'),'👥|Inni jedzą','🕐|Jest pora posiłku','✍️|Inne!o']},
  {s:'Ty i jedzenie',id:'sygnaly',type:'single',q:(c)=>c.g('Czy łatwo rozpoznajesz, że jesteś głodny albo najedzony?','Czy łatwo rozpoznajesz, że jesteś głodna albo najedzona?','Czy łatwo rozpoznajesz u siebie głód i sytość?'),opts:['🎯|Tak, łatwo','🌤️|Różnie!o','🌫️|Raczej trudno','⏰|Głód czuję dopiero, gdy jest bardzo silny']},
  {s:'Ty i jedzenie',id:'tempo',tip:"<div class=\"tip\"><span class=\"te\">🐢</span><div><p><b class=\"tl\">Ciekawostka</b> Wolniej znaczy mniej. Sygnały sytości docierają do mózgu z opóźnieniem, często mówi się o <b>ok. 20 minutach</b>. Dlatego warto zwolnić i chwilę odczekać przed dokładką. Przy szybkim jedzeniu łatwo zjeść więcej, niż potrzebujemy, i poczuć ciężar dopiero chwilę później.</p><p><b>PS.</b> Stąd to znajome uczucie ciężkiego brzucha po świątecznym obiedzie. 🎄</p><p class=\"src\">Źródło: <a href=\"https://ora.ox.ac.uk/objects/uuid:1609de9b-565c-4e01-b0ed-a1054c3b6e3e\" target=\"_blank\" rel=\"noopener\">Robinson i in., American Journal of Clinical Nutrition 2014</a></p></div></div>",type:'single',q:'Jak szybko jesz?',hint:'Chodzi o typowy główny posiłek, np. obiad.',opts:['🐇|Szybko (do 10 min)','🚶|Średnio (10–20 min)','🐢|Powoli (ponad 20 min)','🤷|To zależy!o']},
  {s:'Ty i jedzenie',id:'ekran',type:'single',q:'Jak często jesz przy telefonie, TV lub komputerze?',opts:['📱|Prawie zawsze','📺|Często','🖥️|Czasem','🍽️|Rzadko','✍️|Inne!o']},
  {s:'Ty i jedzenie',id:'kontrola',type:'single',q:'Czy zdarza Ci się zjeść dużo naraz i czuć, że trudno przestać?',opts:['🌿|Nigdy','🌙|Rzadziej niż raz w miesiącu','📆|Kilka razy w miesiącu','🔁|Co tydzień lub częściej','✍️|Inne!o']},
  {s:'Ty i jedzenie',id:'pokusy',type:'multi',q:'Od czego najtrudniej Ci się powstrzymać?',hint:'Zaznacz wszystko, co pasuje.',opts:['🍫|Słodycze','🍔|Tłuste jedzenie, fast food','🥨|Słone przekąski (chipsy, paluszki)','🥖|Pieczywo, bułki','🧀|Ser','🥤|Słodkie napoje','🍷|Alkohol','✍️|Inne!o','👌|Nic szczególnego!x']},
  {s:'Ty i jedzenie',id:'trudno',type:'multi',q:'Kiedy najtrudniej Ci się powstrzymać przed podjadaniem albo zjedzeniem czegoś bardzo słodkiego, tłustego lub słonego?',opts:['🌅|Rano','💼|W pracy / w szkole','🌇|Po południu','🌆|Wieczorem','🌃|W nocy','🎈|W weekendy','🎂|Na imprezach i wyjściach','✍️|Inne!o','👌|Nie mam takich momentów!x']},
  {s:'Ty i jedzenie',id:'diety',type:'single',q:(c)=>c.g('Ile razy byłeś już na diecie?','Ile razy byłaś już na diecie?','Ile diet masz już za sobą?'),opts:(c)=>[c.g('0️⃣|Nigdy','0️⃣|Nigdy','0️⃣|Żadnej'),'🔂|1–2','🔁|3–5','♾️|Więcej niż 5','✍️|Inne!o']},
  {s:'Ty i jedzenie',id:'przeszkody',type:'multi',q:'Co było najtrudniejsze w poprzednich próbach?',opts:['⏰|Brak czasu','🙈|Brak chęci / dyscypliny','😩|Głód','🍫|Ochota na słodycze','🔂|Monotonia','🎉|Imprezy, wyjścia','😰|Stres','📉|Brak efektów','🎢|Efekt jo-jo','👨‍👩‍👧|Gotowanie dla rodziny','✍️|Inne!o','➖|Nie dotyczy!x']},
  {s:'Ty i jedzenie',id:'relacja',type:'scale',q:'Jak oceniasz swoją relację z jedzeniem?',lo:'Trudna',hi:'Spokojna',faces:['😣','😕','😐','🙂','😊']},
  {s:'Ty i jedzenie',id:'gotowosc',type:'scale',q:(c)=>c.g('Na ile czujesz się gotowy na zmiany teraz?','Na ile czujesz się gotowa na zmiany teraz?','Na ile masz teraz w sobie gotowość na zmiany?'),lo:'Wcale',hi:'W pełni',faces:['🐌','🌱','🌿','🌳','🚀']},
  {s:'Ty i jedzenie',id:'wsparcie',type:'single',q:'Czy bliscy wspierają Twoje zmiany?',opts:(c)=>['🤗|Tak','🤝|Częściowo','😶|Raczej nie',c.g('💬|Nie rozmawiałem z nimi o tym','💬|Nie rozmawiałam z nimi o tym','💬|Nie było jeszcze o tym rozmowy'),'✍️|Inne!o']},
  {s:'Na koniec',id:'uwagi',type:'text',q:'Czy jest coś jeszcze, co powinnam wiedzieć?',hint:'Wszystko, co uważasz za ważne. Możesz pominąć.',ph:'np. pracuję na zmiany, w sobotę mam wesele…',none:'Nic więcej'}
];
