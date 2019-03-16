import { Injectable } from '@angular/core';
import * as express from 'express';
import * as fs from 'fs';
import * as http from 'http';
import * as proxy from 'http-proxy-middleware';
import * as https from 'https';
import * as killable from 'killable';
import * as mimeTypes from 'mime-types';
import * as path from 'path';
import { Config } from 'src/app/config';
import { Errors } from 'src/app/enums/errors.enum';
import { DummyJSONParser } from 'src/app/libs/dummy-helpers.lib';
import { ExpressMiddlewares } from 'src/app/libs/express-middlewares.lib';
import { Utils } from 'src/app/libs/utils.lib';
import { AlertService } from 'src/app/services/alert.service';
import { DataService } from 'src/app/services/data.service';
import { EventsService } from 'src/app/services/events.service';
import { pemFiles } from 'src/app/ssl';
import { EnvironmentsStore } from 'src/app/stores/environments.store';
import { EnvironmentType } from 'src/app/types/environment.type';
import { CORSHeaders, HeaderType, mimeTypesWithTemplating, RouteType } from 'src/app/types/route.type';
import { EnvironmentLogsType } from 'src/app/types/server.type';
import { URL } from 'url';

/***
 * TODO
 * use store instead of passed by reference environment (so we don't have to restart for everything)
 *
 * - env route latency DONE
 * - env cors headers override DONE
 */

const httpsConfig = {
  key: pemFiles.key,
  cert: pemFiles.cert
};

@Injectable()
export class ServerService {
  public environmentsLogs: EnvironmentLogsType = {};
  // running servers instances
  private instances: { [key: string]: any } = {};

  constructor(
    private alertService: AlertService,
    private dataService: DataService,
    private eventsService: EventsService,
    private environmentsStore: EnvironmentsStore
  ) {
    this.eventsService.environmentDeleted.subscribe((environmentUUID: string) => {
      this.stop(environmentUUID);
      this.deleteEnvironmentLogs(environmentUUID);
    });
  }

  /**
   * Start an environment / server
   *
   * @param environment - an environment
   */
  public start(environment: EnvironmentType) {
    const server = express();
    let serverInstance;

    // create https or http server instance
    if (environment.https) {
      serverInstance = https.createServer(httpsConfig, server);
    } else {
      serverInstance = http.createServer(server);
    }

    // listen to port
    serverInstance.listen(environment.port, () => {
      this.instances[environment.uuid] = serverInstance;
      this.environmentsStore.update({ type: 'UPDATE_ENVIRONMENT_STATUS', properties: { running: true, needRestart: false } });
    });

    // apply middlewares
    ExpressMiddlewares.forEach(expressMiddleware => {
      server.use(expressMiddleware);
    });

    // apply latency, cors, routes and proxy to express server
    this.logRequests(server, environment);
    this.setEnvironmentLatency(server, environment.uuid);
    this.setRoutes(server, environment);
    this.setCors(server, environment);
    this.enableProxy(server, environment);

    // handle server errors
    serverInstance.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        this.alertService.showAlert('error', Errors.PORT_ALREADY_USED);
      } else if (error.code === 'EACCES') {
        this.alertService.showAlert('error', Errors.PORT_INVALID);
      } else {
        this.alertService.showAlert('error', error.message);
      }
    });

    killable(serverInstance);
  }

  /**
   * Completely stop an environment / server
   */
  public stop(environmentUUID: string) {
    const instance = this.instances[environmentUUID];

    if (instance) {
      instance.kill(() => {
        delete this.instances[environmentUUID];
        this.environmentsStore.update({ type: 'UPDATE_ENVIRONMENT_STATUS', properties: { running: false, needRestart: false } });
      });
    }
  }

  /**
   * Test a header validity
   *
   * @param headerName
   */
  public testHeaderValidity(headerName: string) {
    if (headerName && headerName.match(/[^A-Za-z0-9\-\!\#\$\%\&\'\*\+\.\^\_\`\|\~]/g)) {
      return true;
    }
    return false;
  }

  /**
   * Always answer with status 200 to CORS pre flight OPTIONS requests if option activated.
   * /!\ Must be called after the routes creation otherwise it will intercept all user defined OPTIONS routes.
   *
   * @param server - express instance
   * @param environment - environment to be started
   */
  private setCors(server: any, environment: EnvironmentType) {
    if (environment.cors) {
      server.options('/*', (req, res) => {
        const environmentSelected = this.environmentsStore.getEnvironmentByUUID(environment.uuid);

        this.setHeaders(CORSHeaders, req, res);

        // override default CORS headers with environment's headers
        this.setHeaders(environmentSelected.headers, req, res);

        res.send(200);
      });
    }
  }

  /**
   * Generate an environment routes and attach to running server
   *
   * @param server - server on which attach routes
   * @param environment - environment to get route schema from
   */
  private setRoutes(server: any, environment: EnvironmentType) {
    environment.routes.forEach((route: RouteType) => {
      // only launch non duplicated routes
      if (!route.duplicates.length) {
        try {
          // create route
          server[route.method]('/' + ((environment.endpointPrefix) ? environment.endpointPrefix + '/' : '') + route.endpoint.replace(/ /g, '%20'), (req, res) => {
            // add route latency if any
            setTimeout(() => {
              const routeContentType = Utils.getRouteContentType(environment, route);

              // set http code
              res.status(route.statusCode);

              this.setHeaders(environment.headers, req, res);
              this.setHeaders(route.headers, req, res);

              // send the file
              if (route.filePath) {
                let filePath: string;

                // throw error or serve file
                try {
                  filePath = DummyJSONParser(route.filePath, req);
                  const fileMimeType = mimeTypes.lookup(route.filePath);

                  // if no route content type set to the one detected
                  if (!routeContentType) {
                    res.set('Content-Type', fileMimeType);
                  }

                  let fileContent: Buffer | string = fs.readFileSync(filePath);

                  // parse templating for a limited list of mime types
                  if (mimeTypesWithTemplating.indexOf(fileMimeType) > -1) {
                    fileContent = DummyJSONParser(fileContent.toString('utf-8', 0, fileContent.length), req);
                  }

                  if (!route.sendFileAsBody) {
                    res.set('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
                  }
                  res.send(fileContent);
                } catch (error) {
                  if (error.code === 'ENOENT') {
                    this.sendError(res, Errors.FILE_NOT_EXISTS + filePath, false);
                  } else if (error.message.indexOf('Parse error') > -1) {
                    this.sendError(res, Errors.TEMPLATE_PARSE, false);
                  }
                  res.end();
                }
              } else {
                // detect if content type is json in order to parse
                if (routeContentType === 'application/json') {
                  try {
                    res.json(JSON.parse(DummyJSONParser(route.body, req)));
                  } catch (error) {
                    // if JSON parsing error send plain text error
                    if (error.message.indexOf('Unexpected token') > -1 || error.message.indexOf('Parse error') > -1) {
                      this.sendError(res, Errors.JSON_PARSE);
                    } else if (error.message.indexOf('Missing helper') > -1) {
                      this.sendError(res, Errors.MISSING_HELPER + error.message.split('"')[1]);
                    }
                    res.end();
                  }
                } else {
                  try {
                    res.send(DummyJSONParser(route.body, req));
                  } catch (error) {
                    // if invalid Content-Type provided
                    if (error.message.indexOf('invalid media type') > -1) {
                      this.sendError(res, Errors.INVALID_CONTENT_TYPE);
                    }
                    res.end();
                  }
                }
              }
            }, route.latency);
          });
        } catch (error) {
          // if invalid regex defined
          if (error.message.indexOf('Invalid regular expression') > -1) {
            this.alertService.showAlert('error', Errors.INVALID_ROUTE_REGEX + route.endpoint);
          }
        }
      }
    });
  }

  /**
   * Apply each header to the response
   *
   * @param headers
   * @param req
   * @param res
   */
  private setHeaders(headers: Partial<HeaderType>[], req, res) {
    headers.forEach((header) => {
      if (header.key && header.value && !this.testHeaderValidity(header.key)) {
        res.set(header.key, DummyJSONParser(header.value, req));
      }
    });
  }

  /**
   * Send an error with text/plain content type and the provided message.
   * Also display a toast.
   *
   * @param res
   * @param errorMessage
   * @param showAlert
   */
  private sendError(res: any, errorMessage: string, showAlert = true) {
    if (showAlert) {
      this.alertService.showAlert('error', errorMessage);
    }
    res.set('Content-Type', 'text/plain');
    res.send(errorMessage);
  }

  /**
   * Enable catch all proxy.
   * Restream the body to the proxied API because it already has been intercepted by body parser
   *
   * @param server - server on which to launch the proxy
   * @param environment - environment to get proxy settings from
   */
  private enableProxy(server: any, environment: EnvironmentType) {
    // Add catch all proxy if enabled
    if (environment.proxyMode && environment.proxyHost && this.isValidURL(environment.proxyHost)) {
      // res-stream the body (intercepted by body parser method) and mark as proxied
      const processRequest = (proxyReq, req, res, options) => {
        req.proxied = true;

        if (req.body) {
          proxyReq.setHeader('Content-Length', Buffer.byteLength(req.body));
          // stream the content
          proxyReq.write(req.body);
        }
      };

      server.use('*', proxy({
        target: environment.proxyHost,
        secure: false,
        changeOrigin: true,
        ssl: Object.assign({}, httpsConfig, { agent: false }),
        onProxyReq: processRequest
      }));
    }
  }

  /**
   * Logs all request made to the environment
   *
   * @param server - server on which to log the request
   * @param environment - environment to link log to
   */
  private logRequests(server: any, environment: EnvironmentType) {
    server.use((req, res, next) => {
      let environmentLogs = this.environmentsLogs[environment.uuid];
      if (!environmentLogs) {
        this.environmentsLogs[environment.uuid] = [];
        environmentLogs = this.environmentsLogs[environment.uuid];
      }

      // remove one at the end if we reach maximum
      if (environmentLogs.length >= Config.maxLogsPerEnvironment) {
        environmentLogs.pop();
      }

      environmentLogs.unshift(this.dataService.formatRequestLog(req));

      next();
    });
  }

  /**
   * Set the environment latency if any
   *
   * @param server - server instance
   * @param environmentUUID - environment UUID
   */
  private setEnvironmentLatency(server: any, environmentUUID: string) {
    server.use((req, res, next) => {
      const environmentSelected = this.environmentsStore.getEnvironmentByUUID(environmentUUID);
      setTimeout(next, environmentSelected.latency);
    });
  }

  /**
   * Test if URL is valid
   *
   * @param URL
   */
  public isValidURL(address: string): boolean {
    try {
      const myURL = new URL(address);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Clear the environment logs
   *
   * @param environmentUuid
   */
  public clearEnvironmentLogs(environmentUuid: string) {
    this.environmentsLogs[environmentUuid] = [];
  }

  /**
   * Delete an environment log
   */
  public deleteEnvironmentLogs(environmentUUID: string) {
    delete this.environmentsLogs[environmentUUID];
  }
}
