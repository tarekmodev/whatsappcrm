import { Injectable } from '@nestjs/common';
import { workflowCatalog, type WorkflowCatalogResponse } from '@whatsappcrm/contracts';

/**
 * The vocabulary the builder renders from — 0009's `WorkflowCatalogService`.
 *
 * ## It delegates, and the delegation is the point
 *
 * `workflowCatalog()` lives in `@whatsappcrm/contracts` because TAR-396 needed it
 * to mock this endpoint before this service existed. Keeping a second
 * implementation here would mean the console's mock and the server's answer are
 * two readings of the same constants — which is exactly the drift the catalog
 * endpoint exists to prevent, arriving by the back door.
 *
 * So there is one function, both sides import it, and this class is the thin
 * seam that makes it injectable and testable in a Nest context.
 *
 * ## Why it is an endpoint at all
 *
 * Every value it returns is a compile-time constant the console could import
 * directly. The endpoint is the one that is right when the console is a version
 * behind: it answers with the vocabulary **this server** will accept, so a
 * builder cannot offer an action the API refuses.
 *
 * ## And why it is one endpoint rather than three
 *
 * TAR-392's acceptance criteria list three listings — trigger types, condition
 * operators, action types. A form that renders the builder needs all three
 * before it can render anything, so three endpoints would be three round trips
 * that always happen together and can disagree with each other across a deploy.
 *
 * Pure and synchronous: no database, no tenant scope, nothing to cache.
 */
@Injectable()
export class WorkflowCatalogService {
  get(): WorkflowCatalogResponse {
    return workflowCatalog();
  }
}
