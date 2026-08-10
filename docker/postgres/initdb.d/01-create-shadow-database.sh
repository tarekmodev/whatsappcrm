#!/bin/sh
# Creates the shadow database Prisma needs for `migrate diff --to-migrations`,
# which is how a down migration is generated (README.md → "Rolling a migration
# back"). Prisma creates and drops its own shadow database for `migrate dev`,
# but `migrate diff` requires one that already exists.
#
# Runs only on first initialisation of the `pgdata` volume — it will not re-run
# on an existing volume. If you added this after the fact, either
# `docker compose down -v` (destroys local data) or create it by hand:
#   docker compose exec postgres createdb -U <user> <db>_shadow
#
# It is a throwaway scratch database. Prisma wipes it on every use; never point
# it at anything that holds data.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE "${POSTGRES_DB}_shadow";
EOSQL
