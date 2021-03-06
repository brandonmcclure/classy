/**
 * Created by rtholmes on 2016-06-19.
 */

import Config, {ConfigKey} from "../../common/Config";
import Log from "./../../common/Log";

import Server from "./server/Server";

/**
 * Starts the server; doesn't listen to whether the start was successful.
 */
export class AutoTestDaemon {

    public initServer() {
        Log.info("AutoTestDaemon::initServer() - start");

        const portNum = Number(Config.getInstance().getProp(ConfigKey.autotestPort));

        // start server
        const s = new Server();
        s.setPort(portNum);
        s.start().then(function(val: boolean) {
            Log.info("AutoTestDaemon::initServer() - started: " + val);
        }).catch(function(err: Error) {
            Log.error("AutoTestDaemon::initServer() - ERROR: " + err.message);
        });
    }

}

// This ends up starting the whole system
Log.info("AutoTest Daemon - starting");
const app = new AutoTestDaemon();
app.initServer();

Log.info("AutoTestDaemon - registering unhandled rejection");

process.on('unhandledRejection', (reason, p) => {
    try {
        Log.error('AutoTestDaemon - unhandled promise'); // in case next line fails
        // tslint:disable-next-line
        console.log('AutoTestDaemon - unhandled rejection at: ', p, '; reason:', reason);
        Log.error('AutoTestDaemon - unhandled promise: ' + JSON.stringify(reason));
    } catch (err) {
        // eat any error
    }
});
Log.info("AutoTestDaemon - registering unhandled rejection; done");
