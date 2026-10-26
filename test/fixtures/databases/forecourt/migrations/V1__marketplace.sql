-- The marketplace: dealers, their vehicles and photos, saved vehicles, inquiries and
-- their activity, and the front page's images.
CREATE TABLE dealer(id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, about TEXT);
CREATE TABLE vehicle(id INTEGER PRIMARY KEY, stock_ref TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  make TEXT NOT NULL, model TEXT NOT NULL, trim TEXT, engine TEXT, year INTEGER NOT NULL,
  price INTEGER NOT NULL CHECK(price > 0), mileage INTEGER NOT NULL CHECK(mileage >= 0),
  body_type TEXT NOT NULL CHECK(body_type IN ('Hatchback','Sedan','Wagon','SUV','Coupe','Pickup','Van')),
  fuel TEXT NOT NULL CHECK(fuel IN ('Gas','Diesel','Hybrid','Electric')),
  transmission TEXT NOT NULL CHECK(transmission IN ('Manual','Automatic')),
  drivetrain TEXT NOT NULL CHECK(drivetrain IN ('FWD','RWD','AWD')),
  color TEXT NOT NULL, doors INTEGER, seats INTEGER, owners INTEGER,
  status TEXT NOT NULL DEFAULT 'listed' CHECK(status IN ('listed','reserved','sold')),
  featured BOOLEAN NOT NULL DEFAULT 0, highlight TEXT, description TEXT, features TEXT,
  service_records TEXT NOT NULL CHECK(service_records IN ('Full','Partial')),
  keys INTEGER NOT NULL CHECK(keys > 0),
  battery_health INTEGER CHECK(battery_health BETWEEN 0 AND 100),
  est_monthly INTEGER NOT NULL CHECK(est_monthly > 0),
  listed_on DATE NOT NULL, dealer_id INTEGER NOT NULL REFERENCES dealer(id),
  version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE vehicle_photo(id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicle(id), position INTEGER NOT NULL,
  caption TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT NOT NULL, byte_size INTEGER NOT NULL, data BLOB NOT NULL,
  thumbnail BLOB);
CREATE TABLE saved_vehicle(id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, vehicle_id INTEGER NOT NULL REFERENCES vehicle(id),
  saved_at TIMESTAMP NOT NULL, active BOOLEAN NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id, vehicle_id));
CREATE TABLE inquiry(id INTEGER PRIMARY KEY, reference TEXT NOT NULL UNIQUE, stock_ref TEXT NOT NULL,
  vehicle_id INTEGER REFERENCES vehicle(id), name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, message TEXT NOT NULL,
  received_at TIMESTAMP NOT NULL, account_id TEXT, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','replied','closed')),
  version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE inquiry_activity(id INTEGER PRIMARY KEY, inquiry_id INTEGER NOT NULL REFERENCES inquiry(id),
  title TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT NOT NULL, recorded_at TIMESTAMP NOT NULL);
CREATE TABLE site_image(id INTEGER PRIMARY KEY, name TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL, data BLOB NOT NULL);
-- The references a record's lists find their rows by (mistri check names each).
CREATE INDEX vehicle_seller ON vehicle(dealer_id);
CREATE INDEX vehicle_photo_vehicle ON vehicle_photo(vehicle_id);
