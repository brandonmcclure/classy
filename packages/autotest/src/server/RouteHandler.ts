import * as Docker from "dockerode";
import * as fs from "fs-extra";
import * as restify from "restify";
import {URL} from "url";
import Config, {ConfigKey} from "../../../common/Config";
import Log from "../../../common/Log";
import {CommitTarget} from "../../../common/types/ContainerTypes";
import Util from "../../../common/Util";
import {AutoTest} from "../autotest/AutoTest";
import {ClassPortal} from "../autotest/ClassPortal";
import {MongoDataStore} from "../autotest/DataStore";
import {EdXClassPortal} from "../edx/EdxClassPortal";
import {GitHubAutoTest} from "../github/GitHubAutoTest";
import {GitHubUtil} from "../github/GitHubUtil";

export default class RouteHandler {
    public static docker: Docker = null;
    public static autoTest: AutoTest = null;

    public static getDocker(): Docker {
        if (RouteHandler.docker === null) {
            if (Config.getInstance().getProp(ConfigKey.name) === "classytest") {
                // Running tests; don't need to connect to the Docker daemon
                this.docker = null;
            } else {
                const dockerHost = Config.getInstance().getProp(ConfigKey.dockerHost) || "";
                if (dockerHost.startsWith("https") || dockerHost.startsWith("http") || dockerHost.startsWith("tcp")) {
                    const dockerUrl = new URL(dockerHost);
                    RouteHandler.docker = new Docker({
                        host: dockerUrl.hostname,
                        port: dockerUrl.port,
                        ca: fs.readFileSync("/etc/ssl/certs/ca-certificates.crt"),
                        cert: fs.readFileSync(Config.getInstance().getProp(ConfigKey.sslCertPath)),
                        key: fs.readFileSync(Config.getInstance().getProp(ConfigKey.sslKeyPath)),
                        version: "v1.30"
                    });
                } else {
                    Log.info("RouteHandler::getDocker() - Defaulting to Docker socket.");
                    RouteHandler.docker = new Docker();
                }
            }
        }

        return RouteHandler.docker;
    }

    public static getAutoTest(): AutoTest {
        if (RouteHandler.autoTest === null) {
            const dataStore = new MongoDataStore();
            const docker = RouteHandler.getDocker();
            let portal: ClassPortal;

            if (Config.getInstance().getProp(ConfigKey.name) === "sdmm") {
                portal = new EdXClassPortal();
            } else {
                portal = new ClassPortal();
            }

            RouteHandler.autoTest = new GitHubAutoTest(dataStore, portal, docker);
        }
        return RouteHandler.autoTest;
    }

    /**
     * Handles GitHub POSTs, currently:
     *  - commit_comment
     *  - push
     */
    public static postGithubHook(req: restify.Request, res: restify.Response, next: restify.Next) {
        const start = Date.now();
        const githubEvent: string = req.header("X-GitHub-Event");
        Log.info("RouteHandler::postGithubHook(..) - start; handling event: " + githubEvent);
        const body = req.body;

        const handleError = function(msg: string) {
            Log.error("RouteHandler::postGithubHook() - failure; ERROR: " + msg + "; took: " + Util.took(start));
            res.json(400, "Failed to process commit.");
        };

        if (githubEvent === 'ping') {
            // github test packet; use to let the webhooks know we are listening
            Log.info("RouteHandler::postGithubHook() - <200> pong.");
            res.json(200, "pong");
        } else {
            RouteHandler.handleWebhook(githubEvent, body).then(function(commitEvent) {
                if (commitEvent !== null) {
                    res.json(200, commitEvent); // report back our interpretation of the hook
                } else {
                    // handleError("Error handling webhook; event: " + githubEvent + "; body: " + JSON.stringify(body, null, 2));
                    handleError("Webhook not handled (if branch was deleted this is normal)");
                }
            }).catch(function(err) {
                Log.error("RouteHandler::postGithubHook() - ERROR: " + err);
                handleError(err);
            });
        }
        return next();
    }

    private static async handleWebhook(event: string, body: string): Promise<CommitTarget> {

        // cast is unfortunate, but if we're listening to these routes it must be a github AT instance
        const at: GitHubAutoTest = RouteHandler.getAutoTest() as GitHubAutoTest;

        switch (event) {
            case "commit_comment":
                const commentEvent = await GitHubUtil.processComment(body);
                Log.trace("RouteHandler::handleWebhook() - comment request: " + JSON.stringify(commentEvent, null, 2));
                await at.handleCommentEvent(commentEvent);
                return commentEvent;
            case "push":
                const pushEvent = await GitHubUtil.processPush(body, new ClassPortal());
                Log.trace("RouteHandler::handleWebhook() - push request: " + JSON.stringify(pushEvent, null, 2));
                await at.handlePushEvent(pushEvent);
                return pushEvent;
            default:
                Log.error("RouteHandler::handleWebhook() - Unhandled GitHub event: " + event);
                throw new Error("Unhandled GitHub hook event: " + event);
        }
    }

    public static getResource(req: restify.Request, res: restify.Response, next: restify.Next) {
        const path = Config.getInstance().getProp(ConfigKey.persistDir) + "/" + req.url.split("/resource/")[1];
        Log.info("RouteHandler::getResource(..) - start; fetching resource: " + path);

        const rs = fs.createReadStream(path);
        rs.on("error", (err: any) => {
            if (err.code === "ENOENT") {
                Log.error("RouteHandler::getResource(..) - ERROR Requested resource does not exist: " + path);
                res.send(404, err.message);
            } else {
                Log.error("RouteHandler::getResource(..) - ERROR Reading requested resource: " + path);
                res.send(500, err.message);
            }
        });
        rs.on("end", () => {
            rs.close();
        });
        rs.pipe(res);

        next();
    }

    public static async getDockerImages(req: restify.Request, res: restify.Response, next: restify.Next) {
        const docker = RouteHandler.getDocker();
        const images = await docker.listImages();
        res.send(200, images);

        return next();
    }

    public static async postDockerImage(req: restify.Request, res: restify.Response, next: restify.Next) {
        const docker = RouteHandler.getDocker();
        try {
            const body = req.body;
            const remote = body.remote;
            const t = body.tag;
            const stream = await docker.buildImage(null, {remote, t});
            stream.on("error", (err: Error) => {
                Log.error("Error building image. " + err.message);
                res.send(500, "Error building image. " + err.message);
            });
            stream.on("end", () => {
                Log.info("Finished building image.");
            });
            stream.pipe(res);
        } catch (err) {
            res.send(err.statusCode, err.message);
        }

        return next();
    }
}
