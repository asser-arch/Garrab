declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CONFIG_KV: KVNamespace;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    ENVIRONMENT: "dev" | "test" | "staging" | "prod";
    APP_ORIGIN: string;
  }
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("../src/index");
  }
}
declare namespace Cloudflare {
  interface Env {
    FILES: R2Bucket;
    JOBS: Queue<import("../src/jobs-types").Job>;
    ADMIN_DEV_TOKEN: string;
  }
}
