'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { content } from '~/content/en';
import { ProvisionTenantDialog } from './ProvisionTenantDialog';
import { TenantLookup } from './TenantLookup';

/**
 * Region 1 of the Tenants screen: the lookup and, **beside it**, the one other
 * thing an operator does from this card (spec §2.3).
 *
 * One client island rather than two, because the two controls share a row and the
 * dialog is the only state on the screen. Keeping it here is what lets the page
 * stay a server component.
 */
export function TenantsLookupCard() {
  const [isProvisioning, setIsProvisioning] = useState(false);

  return (
    <>
      <TenantLookup
        provisionAction={
          <Button
            variant="secondary"
            onClick={() => {
              setIsProvisioning(true);
            }}
          >
            {content.tenants.provision}
          </Button>
        }
      />
      <ProvisionTenantDialog
        isOpen={isProvisioning}
        onClose={() => {
          setIsProvisioning(false);
        }}
      />
    </>
  );
}
