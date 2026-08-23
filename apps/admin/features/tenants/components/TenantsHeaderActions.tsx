'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Cluster } from '@/components/layout/Cluster';
import { content } from '~/content/en';
import { ProvisionTenantDialog } from './ProvisionTenantDialog';

/**
 * `Provision a tenant`, beside the lookup field it belongs with (spec §2.3).
 *
 * Its own client island so the Tenants page stays a server component: the dialog
 * is the only thing on that screen that needs state, and hoisting `'use client'`
 * to the page would pull the whole screen into the browser bundle.
 */
export function TenantsHeaderActions() {
  const [isProvisioning, setIsProvisioning] = useState(false);

  return (
    <Cluster gap="3">
      <Button
        variant="secondary"
        onClick={() => {
          setIsProvisioning(true);
        }}
      >
        {content.tenants.provision}
      </Button>
      <ProvisionTenantDialog
        isOpen={isProvisioning}
        onClose={() => {
          setIsProvisioning(false);
        }}
      />
    </Cluster>
  );
}
