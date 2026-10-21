-- Menu analysis costs 40 zł (matches the price on the landing page).
update public.services set price_pln = 40 where id = 'analiza-jadlospisu';
-- Package prices (match the landing page).
update public.services set price_pln = 80 where id = 'pakiet-miesieczny';
update public.services set price_pln = 250 where id = 'pakiet-3-miesieczny';
