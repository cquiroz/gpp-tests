#!/bin/bash
# Three empty databases, no schema (spec §3).
#
# Deliberately *not* the lucuma-odb repo's docker-init approach: that applies the migration
# SQL with raw psql, which leaves no Flyway history table and makes the services fail Flyway
# validation on boot. Here each service migrates its own database at startup, so every
# regression run also exercises the migrations from empty.
set -euo pipefail

for db in lucuma-sso prefs; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
    CREATE DATABASE "$db";
SQL
done

echo "created databases: lucuma-odb (POSTGRES_DB), lucuma-sso, prefs"
