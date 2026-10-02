-- =====================================================================
-- 0007 COMMERCE CONFIG: Canadian tax rates and starter shipping rates.
-- Production configuration, editable later from the admin (settings.write).
--
-- Tax rates verified 2026-10-01 (GST 5%; HST ON 13%, NB/NL/PE 15%,
-- NS 14% since 2025-04-01; BC PST 7%, MB RST 7%, SK PST 6%, QC QST 9.975%).
-- Re-verify with an accountant before launch: provincial exemptions
-- (e.g. children's clothing in BC/ON point-of-sale rebate) are not modelled.
-- =====================================================================
insert into public.tax_rates (province, tax_type, label, rate, effective_from, effective_to) values
  ('AB','GST','GST',0.05,'2008-01-01',null),
  ('BC','GST','GST',0.05,'2008-01-01',null), ('BC','PST','BC PST',0.07,'2013-04-01',null),
  ('MB','GST','GST',0.05,'2008-01-01',null), ('MB','RST','MB RST',0.07,'2019-07-01',null),
  ('NB','HST','HST',0.15,'2016-07-01',null),
  ('NL','HST','HST',0.15,'2016-07-01',null),
  ('NS','HST','HST',0.15,'2010-07-01','2025-03-31'), ('NS','HST','HST',0.14,'2025-04-01',null),
  ('NT','GST','GST',0.05,'2008-01-01',null),
  ('NU','GST','GST',0.05,'2008-01-01',null),
  ('ON','HST','HST',0.13,'2010-07-01',null),
  ('PE','HST','HST',0.15,'2016-10-01',null),
  ('QC','GST','GST',0.05,'2008-01-01',null), ('QC','QST','QST',0.09975,'2013-01-01',null),
  ('SK','GST','GST',0.05,'2008-01-01',null), ('SK','PST','SK PST',0.06,'2017-03-23',null),
  ('YT','GST','GST',0.05,'2008-01-01',null);

-- Starter shipping. Carrier stays null until a carrier integration exists;
-- prices are placeholders the owner should set from real carrier quotes.
with z as (
  insert into public.shipping_zones (name, provinces) values
    ('Ontario & Quebec', array['ON','QC']),
    ('Atlantic',         array['NB','NS','PE','NL']),
    ('Prairies',         array['MB','SK','AB']),
    ('British Columbia', array['BC']),
    ('North',            array['YT','NT','NU'])
  returning id, name
)
insert into public.shipping_rates (zone_id, code, label, price_cents, free_over_cents, min_days, max_days, sort_order)
select z.id, r.code, r.label, r.price, r.free_over, r.min_d, r.max_d, r.sort
from z join (values
  ('Ontario & Quebec','standard','Standard',  900, 15000, 2, 5, 0), ('Ontario & Quebec','express','Express',  1900, null, 1, 2, 1),
  ('Atlantic',        'standard','Standard', 1200, 15000, 3, 7, 0), ('Atlantic',        'express','Express',  2400, null, 2, 3, 1),
  ('Prairies',        'standard','Standard', 1200, 15000, 3, 6, 0), ('Prairies',        'express','Express',  2400, null, 2, 3, 1),
  ('British Columbia','standard','Standard', 1400, 15000, 3, 7, 0), ('British Columbia','express','Express',  2600, null, 2, 3, 1),
  ('North',           'standard','Standard', 2500, null,  7,14, 0)
) as r(zone, code, label, price, free_over, min_d, max_d, sort) on r.zone = z.name;
