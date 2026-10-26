-- The marketplace grows a sales desk: what a listing says beyond V1 (its VIN, power,
-- economy or range, interior, the price before a reduction and the day it sold), a
-- dealer's rating, and an inquiry's road from first question to a sale — its stage,
-- who owns it, how it came in, what it is worth and the conversation about it.
-- Every column is added with a default or as nullable, so a V1 marketplace carries on.
ALTER TABLE vehicle ADD COLUMN vin TEXT;
ALTER TABLE vehicle ADD COLUMN interior TEXT;
ALTER TABLE vehicle ADD COLUMN horsepower INTEGER CHECK(horsepower > 0);
ALTER TABLE vehicle ADD COLUMN mpg_city INTEGER CHECK(mpg_city > 0);
ALTER TABLE vehicle ADD COLUMN mpg_highway INTEGER CHECK(mpg_highway > 0);
ALTER TABLE vehicle ADD COLUMN range_mi INTEGER CHECK(range_mi > 0);
ALTER TABLE vehicle ADD COLUMN was_price INTEGER CHECK(was_price > 0);
ALTER TABLE vehicle ADD COLUMN sold_on DATE;

ALTER TABLE dealer ADD COLUMN rating REAL CHECK(rating BETWEEN 1 AND 5);
ALTER TABLE dealer ADD COLUMN reviews INTEGER NOT NULL DEFAULT 0 CHECK(reviews >= 0);

ALTER TABLE inquiry ADD COLUMN stage TEXT NOT NULL DEFAULT 'new'
  CHECK(stage IN ('new','contacted','test_drive','negotiating','won','lost'));
ALTER TABLE inquiry ADD COLUMN topic TEXT NOT NULL DEFAULT 'availability'
  CHECK(topic IN ('availability','test_drive','trade_in','financing','price'));
ALTER TABLE inquiry ADD COLUMN channel TEXT NOT NULL DEFAULT 'web' CHECK(channel IN ('web','account','phone','walk_in'));
ALTER TABLE inquiry ADD COLUMN owner TEXT;
ALTER TABLE inquiry ADD COLUMN deal_value INTEGER CHECK(deal_value >= 0);
ALTER TABLE inquiry ADD COLUMN test_drive_at TIMESTAMP;
ALTER TABLE inquiry ADD COLUMN lost_reason TEXT
  CHECK(lost_reason IN ('bought_elsewhere','price','financing','no_response','sold_to_another'));
ALTER TABLE inquiry ADD COLUMN closed_on DATE;

-- The conversation about one inquiry: the buyer's words, the desk's replies, its
-- internal notes and the steps it took, oldest first. account_id repeats the
-- inquiry's owner so a row policy can show a buyer their own thread and no note.
CREATE TABLE inquiry_message(id INTEGER PRIMARY KEY, inquiry_id INTEGER NOT NULL REFERENCES inquiry(id),
  kind TEXT NOT NULL CHECK(kind IN ('buyer','reply','note','step')), author TEXT NOT NULL, body TEXT NOT NULL,
  sent_at TIMESTAMP NOT NULL, account_id TEXT);

CREATE INDEX inquiry_message_inquiry ON inquiry_message(inquiry_id);
CREATE INDEX inquiry_vehicle ON inquiry(vehicle_id);
CREATE INDEX saved_vehicle_vehicle ON saved_vehicle(vehicle_id);
