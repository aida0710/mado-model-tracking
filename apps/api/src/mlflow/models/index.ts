import { Hono } from 'hono';
import type { Database } from '../../db/database.js';
import type { RegistryService } from '../../services/registryService.js';
import type { ApiEnvironment } from '../../http/request.js';
import { LoggedModelService } from './loggedModelService.js';
import { ModelVersionService } from './modelVersionService.js';
import { RegisteredModelService } from './registeredModelService.js';
import { loggedModelRoutes } from './loggedModelRoutes.js';
import { modelVersionRoutes } from './modelVersionRoutes.js';
import { registeredModelRoutes } from './registeredModelRoutes.js';

export function mlflowModelRoutes(options: {
  database: Database;
  registry: RegistryService;
}): Hono<ApiEnvironment> {
  const logged = new LoggedModelService(options.database);
  const models = new RegisteredModelService(options.database);
  const versions = new ModelVersionService(options.database, options.registry);
  const routes = new Hono<ApiEnvironment>();
  routes.route('/', loggedModelRoutes(logged));
  routes.route('/', registeredModelRoutes(models));
  routes.route('/', modelVersionRoutes({ models, versions }));
  return routes;
}
