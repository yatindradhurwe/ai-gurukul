-- School transport (vehicles, routes, stops, riders) and hostels (buildings,
-- rooms, allocations). Every table is tenant-owned and isolated with the same
-- FORCEd RLS policy as 004.

CREATE TABLE transport_vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  registration_no text NOT NULL,
  label           text NOT NULL DEFAULT '',          -- e.g. "Bus 3"
  capacity        int  NOT NULL CHECK (capacity > 0),
  driver_name     text NOT NULL DEFAULT '',
  driver_phone    text,
  attendant_name  text,
  attendant_phone text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','retired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, registration_no)
);

CREATE TABLE transport_routes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  vehicle_id uuid REFERENCES transport_vehicles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE transport_stops (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id    uuid NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  name        text NOT NULL,
  landmark    text,
  sequence    int  NOT NULL,
  pickup_time time NOT NULL,
  drop_time   time NOT NULL,
  UNIQUE (route_id, sequence)
);

CREATE TABLE transport_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  route_id   uuid NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
  stop_id    uuid NOT NULL REFERENCES transport_stops(id) ON DELETE CASCADE,
  direction  text NOT NULL DEFAULT 'both' CHECK (direction IN ('both','pickup','drop')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id)
);
CREATE INDEX transport_assignments_route_idx ON transport_assignments (tenant_id, route_id);

CREATE TABLE hostels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'coed' CHECK (kind IN ('boys','girls','coed')),
  warden_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  phone      text,
  address    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE hostel_rooms (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hostel_id uuid NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  room_no   text NOT NULL,
  floor     int  NOT NULL DEFAULT 0,
  capacity  int  NOT NULL CHECK (capacity > 0),
  room_type text NOT NULL DEFAULT 'standard',
  UNIQUE (hostel_id, room_no)
);

CREATE TABLE hostel_allocations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL REFERENCES hostel_rooms(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES student_profiles(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date   date,                                   -- NULL = currently living there
  notes      text,
  created_by uuid NOT NULL REFERENCES users(id),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
-- A student holds at most one bed at a time.
CREATE UNIQUE INDEX hostel_allocations_active_idx ON hostel_allocations (student_id) WHERE end_date IS NULL;
CREATE INDEX hostel_allocations_room_idx ON hostel_allocations (tenant_id, room_id) WHERE end_date IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transport_vehicles','transport_routes','transport_stops','transport_assignments','hostels','hostel_rooms','hostel_allocations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (app_is_system() OR tenant_id = current_tenant_id()) WITH CHECK (app_is_system() OR tenant_id = current_tenant_id())', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gurukul_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON transport_vehicles, transport_routes, transport_stops, transport_assignments,
      hostels, hostel_rooms, hostel_allocations TO gurukul_app;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant to gurukul_app; skipping';
END $$;
