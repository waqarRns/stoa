/*******************************************************************************

    Define the configuration objects that are used through the application

    Copyright:
        Copyright (c) 2020-2021 BOSAGORA Foundation
    All rights reserved.

    License:
        MIT License. See LICENSE for details.

*******************************************************************************/

import { Utils } from "boa-sdk-ts";

import { ArgumentParser } from "argparse";
import extend from "extend";
import fs from "fs";
import ip from "ip";
import yaml from "js-yaml";
import path from "path";
import { URL } from "url";

/**
 * Main config
 */
export class Config implements IConfig {
    /**
     * Server config
     */
    public server: ServerConfig;

    /**
     * Database config
     */
    public database: DatabaseConfig;

    /**
     * Logging config
     */
    public logging: LoggingConfig;

    /**
     * Consensus config
     */
    public consensus: ConsensusConfig;

    /**
     * Votera server config
     */
    public votera?: VoteraConfig;

    /**
     * Sendgrid config
     */
    public sendgrid: SendgridConfig;


    /**
     * Constructor
     */
    constructor() {
        this.server = new ServerConfig();
        this.database = new DatabaseConfig();
        this.logging = new LoggingConfig();
        this.consensus = new ConsensusConfig();
        this.votera = new VoteraConfig();
        this.sendgrid = new SendgridConfig();
    }

    /**
     * Reads from file
     * @param config_file The file name of configuration
     */
    public readFromFile(config_file: string) {
        const config_content = fs.readFileSync(path.resolve(Utils.getInitCWD(), config_file), "utf8");
        this.readFromString(config_content);
    }

    /**
     * Reads from string
     * @param config_content The content of configuration
     */
    public readFromString(config_content: string) {
        const cfg = yaml.safeLoad(config_content) as IConfig;
        this.server.readFromObject(cfg.server);
        this.database.readFromObject(cfg.database);
        this.logging.readFromObject(cfg.logging);
        this.consensus.readFromObject(cfg.consensus);
        if (cfg.server.required_sendgrid) this.sendgrid.readFromObject(cfg.sendgrid);
        if (cfg.server.require_votera && cfg.votera) this.votera?.readFromObject(cfg.votera);
    }

    /**
     * Parses the command line arguments, Reads from the configuration file
     */
    public static createWithArgument(): Config {
        // Parse the arguments
        const parser = new ArgumentParser();
        parser.add_argument("-c", "--config", {
            default: "config.yaml",
            help: "Path to the config file to use",
        });
        const args = parser.parse_args();

        const configPath = path.resolve(Utils.getInitCWD(), args.config);
        if (!fs.existsSync(configPath)) {
            console.error(`Config file '${configPath}' does not exists`);
            process.exit(1);
        }

        const cfg = new Config();
        try {
            cfg.readFromFile(configPath);
        } catch (error) {
            // Logging setup has not been completed and is output to the console.
            console.error(error.message);

            // If the process fails to read the configuration file, the process exits.
            process.exit(1);
        }
        return cfg;
    }
}

/**
 * Server config
 */
export class ServerConfig implements IServerConfig {
    /**
     * THe address to which we bind
     */
    public address: string;

    /**
     * The port on which we bind
     */
    public port: number;

    /**
     * The private port on which bind
     */
    public private_port: number;

    /**
     * The endpoint of Agora
     */
    public agora_endpoint: URL;

    /**
     * The votera required status
     */
    public require_votera: boolean;

    /**
     * Required Sendgrid status
     */
    public required_sendgrid: boolean;

    /**
     * Excluded Addresses
     */
    public excludedAddresses: string[];

    /**
     * Constructor
     * @param address The address to which we bind
     * @param port The port on which we bind
     * @param agora_endpoint The endpoint of Agora
     */
    constructor(address?: string, port?: number, private_port?: number, agora_endpoint?: string) {
        const conf = extend(true, {}, ServerConfig.defaultValue());
        extend(true, conf, { address, port, agora_endpoint });

        if (!ip.isV4Format(conf.address) && !ip.isV6Format(conf.address)) {
            console.error(`${conf.address}' is not appropriate to use as an IP address.`);
            process.exit(1);
        }

        this.address = conf.address;
        this.port = conf.port;
        this.private_port = conf.private_port;
        this.agora_endpoint = conf.agora_endpoint;
        this.require_votera = conf.require_votera;
        this.required_sendgrid = conf.required_sendgrid;
        this.excludedAddresses = conf.excludedAddresses;
    }

    /**
     * Reads from Object
     * @param config The object of IServerConfig
     */
    public readFromObject(config: IServerConfig) {
        const conf = extend(true, {}, ServerConfig.defaultValue());
        extend(true, conf, config);

        if (!ip.isV4Format(conf.address) && !ip.isV6Format(conf.address)) {
            console.error(`${conf.address}' is not appropriate to use as an IP address.`);
            process.exit(1);
        }
        this.address = conf.address;
        this.port = conf.port;
        this.private_port = conf.private_port;
        this.agora_endpoint = conf.agora_endpoint;
        this.require_votera = conf.require_votera;
        this.required_sendgrid = conf.required_sendgrid;
        this.excludedAddresses = conf.excludedAddresses;
    }

    /**
     * Returns default value
     */
    public static defaultValue(): IServerConfig {
        return {
            address: "127.0.0.1",
            port: 3836,
            private_port: 3835,
            agora_endpoint: new URL("http://127.0.0.1:2826"),
            require_votera: false,
            required_sendgrid: false,
            excludedAddresses: []
        };
    }
}

/**
 * Database config
 */
export class DatabaseConfig implements IDatabaseConfig {
    /**
     * The host of mysql
     */
    host: string;

    /**
     * The user of mysql
     */
    user: string;

    /**
     * The pasword of mysql
     */
    password: string;

    /**
     * The database name
     */
    database?: string;

    /**
     * The host database port
     */
    port: number;

    /**
     * multiple Statements exec config
     */
    multipleStatements: boolean;

    /**
     * The maximum number of connections to create at once.
     */
    waitForConnections: boolean;

    /**
     * The maximum number of connections
     */
    connectionLimit: number;

    /**
     * The maximum number of connection requests the pool
     * will queue before returning an error from getConnection.
     * If set to 0, there is no limit to the number of queued connection requests.
     */
    queueLimit: number;

    /**
     * Constructor
     * @param host Mysql database host
     * @param user Mysql database user
     * @param password Mysql database password
     * @param database Mysql database name
     * @param multipleStatements Mysql allow multiple statement to execute (true / false)
     */
    constructor(
        host?: string,
        user?: string,
        password?: string,
        database?: string,
        port?: number,
        multipleStatements?: boolean,
        waitForConnections?: boolean,
        connectionLimit?: number,
        queueLimit?: number
    ) {
        const conf = extend(true, {}, DatabaseConfig.defaultValue());
        extend(true, conf, {
            host,
            user,
            password,
            database,
            port,
            multipleStatements,
            waitForConnections,
            connectionLimit,
            queueLimit,
        });
        this.host = conf.host;
        this.user = conf.user;
        this.password = conf.password;
        this.database = conf.database;
        this.port = conf.port;
        this.multipleStatements = conf.multipleStatements;
        this.waitForConnections = conf.waitForConnections;
        this.connectionLimit = conf.connectionLimit;
        this.queueLimit = conf.queueLimit;
    }

    /**
     * Reads from Object
     * @param config The object of IDatabaseConfig
     */
    public readFromObject(config: IDatabaseConfig) {
        const conf = extend(true, {}, DatabaseConfig.defaultValue());
        extend(true, conf, config);
        this.host = conf.host;
        this.user = conf.user;
        this.password = conf.password;
        this.database = conf.database;
        this.port = conf.port;
        this.multipleStatements = conf.multipleStatements;
        this.waitForConnections = conf.waitForConnections;
        this.connectionLimit = conf.connectionLimit;
        this.queueLimit = conf.queueLimit;
    }

    /**
     * Returns default value
     */
    public static defaultValue(): IDatabaseConfig {
        return {
            host: "localhost",
            user: "root",
            password: "",
            database: "stoa",
            port: 3306,
            multipleStatements: true,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
        };
    }
}

/**
 * Logging config
 */
export class LoggingConfig implements ILoggingConfig {
    /**
     * The path of logging files
     */
    public folder: string;

    /**
     * The level of logging
     */
    public level: string;

    /**
     * Whether the console is enabled as well
     */
    public console: boolean;

    /**
     * Wheather db log is enable or not
     */
    public database: boolean;

    /**
     * url of mongodb to store logs
     */
    public mongodb_url: string;

    /**
     * Constructor
     */
    constructor() {
        const defaults = LoggingConfig.defaultValue();
        this.folder = path.resolve(Utils.getInitCWD(), defaults.folder);
        this.level = defaults.level;
        this.console = defaults.console;
        this.database = defaults.database;
        this.mongodb_url = defaults.mongodb_url;
    }

    /**
     * Reads from Object
     * @param config The object of ILoggingConfig
     */
    public readFromObject(config: ILoggingConfig) {
        if (config.folder) this.folder = path.resolve(Utils.getInitCWD(), config.folder);
        if (config.level) this.level = config.level;
        if (config.console !== undefined) this.console = config.console;
        if (config.database !== undefined) this.database = config.database;
        this.mongodb_url = config.mongodb_url;
    }

    /**
     * Returns default value
     */
    public static defaultValue(): ILoggingConfig {
        return {
            folder: path.resolve(Utils.getInitCWD(), "logs/"),
            level: "info",
            console: false,
            database: false,
            mongodb_url: "mongodb://localhost:27017/?readPreference=primary&appname=MongoDB%20Compass&ssl=false",
        };
    }
}

/**
 * Consensus config
 */
export class ConsensusConfig implements IConsensusConfig {
    /**
     * The genesis timestamp
     */
    public genesis_timestamp: number;

    /**
     * The block interval(second)
     */
    public block_interval: number;

    /**
     * The cycle length for a validator
     */
    public validator_cycle: number;

    /**
     * Constructor
     */
    constructor() {
        const defaults = ConsensusConfig.defaultValue();
        this.genesis_timestamp = defaults.genesis_timestamp;
        this.block_interval = defaults.block_interval;
        this.validator_cycle = defaults.validator_cycle;
    }

    /**
     * Reads from Object
     * @param config The object of IConsensusConfig
     */
    public readFromObject(config: IConsensusConfig) {
        const conf = extend(true, {}, ConsensusConfig.defaultValue());
        extend(true, conf, config);
        this.genesis_timestamp = conf.genesis_timestamp;
        this.block_interval = conf.block_interval;
        this.validator_cycle = conf.validator_cycle;
    }

    /**
     * Returns default value
     */
    public static defaultValue(): IConsensusConfig {
        return {
            genesis_timestamp: 1609459200,
            validator_cycle: 1008,
            block_interval: 10 * 60,
        };
    }
}

/**
 * Votera config
 */
export class VoteraConfig implements IVoteraConfig {
    /**
     * The address to which we bind
     */
    address: string;

    /**
     * The port on which we bind
     */
    port: number;

    /**
     * The endpoint of Votera
     */
    votera_endpoint: URL;

    /**
     * Constructor
     * @param address The address to which we bind
     * @param port The port on which we bind
     * @param votera_endpoint The endpoint of votera
     */
    constructor() {
        const defaults = VoteraConfig.defaultValue();
        this.address = defaults.address;
        this.port = defaults.port;
        this.votera_endpoint = defaults.votera_endpoint;
    }

    /**
     * Reads from Object
     * @param config The object of IVoteraConfig
     */
    public readFromObject(config: IVoteraConfig) {
        const conf = extend(true, {}, VoteraConfig.defaultValue());
        extend(true, conf, config);

        if (!ip.isV4Format(conf.address) && !ip.isV6Format(conf.address)) {
            console.error(`${conf.address}' is not appropriate to use as an IP address.`);
            process.exit(1);
        }
        this.address = conf.address;
        this.port = conf.port;
        this.votera_endpoint = conf.votera_endpoint;
    }

    /**
     * Returns default value
     */
    public static defaultValue(): IVoteraConfig {
        return {
            address: "127.0.0.1",
            port: 5000,
            votera_endpoint: new URL("http://127.0.0.1:5000"),
        };
    }
}

/**
 * Sendgrid config
 */
export class SendgridConfig implements ISendgridConfig {
    /**
     * The API key 
     */
    api_key: string;

    /**
     * Email
     */
    email: string;

    /**
     * Receiver Email
     */
    receiver_email: string;

    /**
     * Constructor
     * @param api_key The Sendgrid API key to which we bind
     * @param email The eamil on which we bind
     * @param receiver_email The eamil of the receciver on which we bind
     */
    constructor() {
        const defaults = SendgridConfig.defaultValue();
        this.api_key = defaults.api_key;
        this.email = defaults.email;
        this.receiver_email = defaults.receiver_email;
    }

    /**
     * Reads from Object
     * @param config The object of ISendgridConfig
     */
    public readFromObject(config: ISendgridConfig) {
        const conf = extend(true, {}, SendgridConfig.defaultValue());
        extend(true, conf, config);

        this.api_key = conf.api_key;
        this.email = conf.email;
        this.receiver_email = conf.receiver_email;
    }

    /**
     * Returns default value
     */
    public static defaultValue(): ISendgridConfig {
        return {
            api_key: '',
            email: '',
            receiver_email: '',
        };
    }
}

/**
 * The interface of server config
 */
export interface IServerConfig {
    /**
     * THe address to which we bind
     */
    address: string;

    /**
     * The port on which we bind
     */
    port: number;

    /**
     * The priavte port on which bind
     */
    private_port: number;

    /**
     * The endpoint of Agora
     */
    agora_endpoint: URL;

    /**
     * The votera required status
     */
    require_votera: boolean;

    /**
     * Required Sendgrid status
     */
    required_sendgrid: boolean;

    /**
     * Excluded Addresses
     */
    excludedAddresses: string[];

}

/**
 * The interface of database config
 */
export interface IDatabaseConfig {
    /**
     * The host of mysql
     */
    host: string;

    /**
     * The user of mysql
     */
    user: string;

    /**
     * The pasword of mysql
     */
    password: string;

    /**
     * The database name
     */
    database?: string;

    /**
     * The host database port
     */
    port: number;

    /**
     * Multiple Statements execution statement Option
     */
    multipleStatements: boolean;

    /**
     * The maximum number of connections to create at once.
     */
    waitForConnections: boolean;

    /**
     * The maximum number of connections
     */
    connectionLimit: number;

    /**
     * The maximum number of connection requests the pool
     * will queue before returning an error from getConnection.
     * If set to 0, there is no limit to the number of queued connection requests.
     */
    queueLimit: number;
}

/**
 * The interface of logging config
 */
export interface ILoggingConfig {
    /**
     * The path of logging files
     */
    folder: string;

    /**
     * The level of logging
     */
    level: string;

    /**
     * Whether the console is enabled as well
     */
    console: boolean;

    /**
     * Wheather db log is enable or not
     */
    database: boolean;

    /**
     * url of mongodb to store logs
     */
    mongodb_url: string;
}

/**
 * The interface of consensus config
 */
export interface IConsensusConfig {
    /**
     * The genesis timestamp
     */
    genesis_timestamp: number;

    /**
     * The block interval(second)
     */
    block_interval: number;

    /**
     * The cycle length for a validator
     */
    validator_cycle: number;
}

/**
 * The interface of main config
 */
export interface IConfig {
    /**
     * Server config
     */
    server: IServerConfig;

    /**
     * Database config
     */
    database: IDatabaseConfig;

    /**
     * Logging config
     */
    logging: ILoggingConfig;

    /**
     * Consensus config
     */
    consensus: IConsensusConfig;
    /**
     * Votera config
     */
    votera?: IVoteraConfig;

    /**
     * Sendgrid config
     */
    sendgrid: ISendgridConfig
}

/**
 * The interface of Votera
 */
export interface IVoteraConfig {
    /**
     * The address to which we bind
     */
    address: string;

    /**
     * The port on which we bind
     */
    port: number;

    /**
     * The endpoint of votera
     */
    votera_endpoint: URL;
}

/**
 * The interface of Sendgrid
 */
export interface ISendgridConfig {
    /**
     * The Sendgrid API key
     */
    api_key: string;

    /**
     * Email
     */
    email: string;

    /**
     * Receiver Email
     */
    receiver_email: string;
}