-- THROWAWAY (TAR-96). Do not merge. This migration deliberately introduces the
-- exact regression TAR-88 warned about — a new tenant-scoped table with no RLS
-- enabled, no FORCE, and no `tenant_isolation` policy — so that the `Database`
-- job goes red and the merge button can be observed blocking. Delete the branch
-- once the protection rule is proven.
CREATE TABLE "tar96_spot_check" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,

    CONSTRAINT "tar96_spot_check_pkey" PRIMARY KEY ("id")
);
