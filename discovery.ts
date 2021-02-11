import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const NODES_SET = "colyseus:nodes";
const ROOM_COUNT_KEY = "roomcount";
const DISCOVERY_CHANNEL = "colyseus:nodes:discovery";

const redis = new Redis(REDIS_URL);
const sub = new Redis(REDIS_URL);


redis.defineCommand('getCurrentProxy', {
    lua: `
    local nodes = redis.call("smembers", "colyseus:nodes")
    if (#nodes < 1) then
        return ""
    end
    
    local nextIdx = redis.call("incr", "currIdx")
    
    local nextIdx = nextIdx % #nodes
    
    if (nextIdx==0) then
        if (#nodes==0) then
            return ""
        end
        nextIdx = nextIdx + 1
    end
    
    local processId = string.match(nodes[nextIdx], "(.*)/")
    redis.call("set","currIdx", nextIdx)
    
    return processId
    `
});

export interface Node {
    processId: string;
    address?: string
}

export type Action = 'add' | 'remove';

function parseNode(data: string): Node {
    const [processId, address] = data.split("/");
    return { processId, address };
}

export async function getNodeList(): Promise<Node[]> {
    const nodes: string[] = await redis.smembers(NODES_SET);
    return nodes.map(data => parseNode(data));
}

export function listen(cb: (action: Action, node: Node) => void) {
    sub.subscribe(DISCOVERY_CHANNEL);
    sub.on("message", (_: string, message: any) => {
        const [action, data] = JSON.parse(message).split(",");
        cb(action, parseNode(data));
    });
}

export async function cleanUpNode(node: Node) {
    const nodeAddress = `${node.processId}/${node.address}`;
    await redis.srem(NODES_SET, nodeAddress);
    await redis.hdel(ROOM_COUNT_KEY, node.processId);
}

export async function getCurrentProxy(): Promise<string> {
    // @ts-ignore
    return await redis.getCurrentProxy();
}

export async function redisSet(key: Redis.KeyType, value: Redis.ValueType) {
    await redis.set(key, value);
}

export async function redisDel(key: Redis.KeyType) {
    await redis.del(key);
}

export async function redisGet(key: Redis.KeyType): Promise<string | null> {
    return await redis.get(key);
}
