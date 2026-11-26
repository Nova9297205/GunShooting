// ============================================================
// HostSimulation: ホスト権威のゲーム状態管理・計算処理
//   - 全プレイヤーの入力適用 / 弾生成 / 敵AI / 当たり判定 / HP / ウェーブ進行
//   - ソロ・ホスト時にのみ実行される（ゲストはスナップショットを受け取るだけ）
// ============================================================
import type {
  EnemySnap,
  EnemyType,
  GameEvent,
  GameResult,
  InputFrame,
  LobbyPlayer,
  Phase,
  PlayerSnap,
  Snapshot,
  ViewState,
} from '../types';
import {
  ENEMY,
  PLAYER,
  PLAYER_SPAWNS,
  SHOOTER,
  TANK_EXPLOSION,
  WORLD_H,
  WORLD_W,
} from './constants';
import {
  circleHitsObstacle,
  firstBlocking,
  hasLineOfSight,
  moveCircle,
  pointInObstacle,
  stepMovement,
} from './physics';

interface SimPlayer extends PlayerSnap {
  queue: InputFrame[];
  shoot: boolean;
  revive: boolean;
  fireCd: number;
}

interface SimEnemy extends EnemySnap {
  kx: number;
  ky: number;
  fireCd: number;
  contactCd: number;
  strafe: number;
  strafeT: number;
  speedMul: number;
  dead: boolean;
}

interface SimBullet {
  id: number;
  team: 'p' | 'e';
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  damage: number;
  radius: number;
  dead: boolean;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

export class HostSimulation {
  players: SimPlayer[] = [];
  enemies: SimEnemy[] = [];
  bullets: SimBullet[] = [];
  phase: Phase = 'intermission';
  wave = 1;
  phaseTimer = 3;
  time = 0;
  tick = 0;
  result: GameResult | null = null;

  private events: GameEvent[] = [];
  private spawnQueue: EnemyType[] = [];
  private spawnTimer = 0;
  private nextId = 1;

  constructor(lobby: LobbyPlayer[]) {
    for (const lp of lobby) {
      const sp = PLAYER_SPAWNS[lp.id % PLAYER_SPAWNS.length];
      this.players.push({
        id: lp.id,
        name: lp.name,
        x: sp.x,
        y: sp.y,
        bodyAngle: -Math.PI / 2,
        aim: -Math.PI / 2,
        hp: PLAYER.maxHp,
        maxHp: PLAYER.maxHp,
        status: 'alive',
        downTimer: 0,
        reviveProgress: 0,
        dashTime: 0,
        dashCd: 0,
        dashDx: 0,
        dashDy: 0,
        shots: 0,
        kills: 0,
        ack: 0,
        queue: [],
        shoot: false,
        revive: false,
        fireCd: 0,
      });
    }
  }

  // ---------------- 外部API ----------------

  queueInput(playerId: number, f: InputFrame): void {
    const p = this.players.find((pl) => pl.id === playerId);
    if (!p) return;
    p.queue.push(f);
    if (p.queue.length > 120) p.queue.splice(0, p.queue.length - 120);
  }

  removePlayer(playerId: number): void {
    this.players = this.players.filter((p) => p.id !== playerId);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  view(): ViewState {
    return {
      time: r2(this.time),
      tick: this.tick,
      phase: this.phase,
      wave: this.wave,
      phaseTimer: r2(this.phaseTimer),
      enemiesLeft: this.enemies.length + this.spawnQueue.length,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        x: r1(p.x),
        y: r1(p.y),
        bodyAngle: r2(p.bodyAngle),
        aim: r2(p.aim),
        hp: Math.ceil(p.hp),
        maxHp: p.maxHp,
        status: p.status,
        downTimer: r1(p.downTimer),
        reviveProgress: r2(p.reviveProgress),
        dashTime: p.dashTime,
        dashCd: p.dashCd,
        dashDx: p.dashDx,
        dashDy: p.dashDy,
        shots: p.shots,
        kills: p.kills,
        ack: p.ack,
      })),
      enemies: this.enemies.map((e) => ({
        id: e.id,
        type: e.type,
        x: r1(e.x),
        y: r1(e.y),
        angle: r2(e.angle),
        hp: Math.ceil(e.hp),
        maxHp: e.maxHp,
        flash: r2(e.flash),
      })),
      bullets: this.bullets.map((b) => ({
        id: b.id,
        team: b.team,
        owner: b.owner,
        x: r1(b.x),
        y: r1(b.y),
        vx: Math.round(b.vx),
        vy: Math.round(b.vy),
      })),
    };
  }

  snapshot(events: GameEvent[]): Snapshot {
    return { ...this.view(), events };
  }

  // ---------------- メインステップ ----------------

  step(dt: number): void {
    if (this.phase === 'gameover') return;
    this.time += dt;
    this.tick++;

    this.updateWave(dt);
    for (const p of this.players) this.updatePlayer(p, dt);
    this.updateRevive(dt);
    for (const e of this.enemies) this.updateEnemy(e, dt);
    this.separateEnemies();
    this.updateBullets(dt);
    this.enemies = this.enemies.filter((e) => !e.dead);
    this.bullets = this.bullets.filter((b) => !b.dead);

    if (this.players.length > 0 && !this.players.some((p) => p.status === 'alive')) {
      this.phase = 'gameover';
      this.result = {
        wave: this.wave,
        players: this.players.map((p) => ({ id: p.id, name: p.name, kills: p.kills })),
      };
    }
  }

  // ---------------- ウェーブ ----------------

  private updateWave(dt: number): void {
    if (this.phase === 'intermission') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.startWave();
      return;
    }
    // combat
    this.phaseTimer += dt;
    const maxAlive = 14 + this.wave * 2;
    this.spawnTimer -= dt;
    if (this.spawnQueue.length > 0 && this.spawnTimer <= 0 && this.enemies.length < maxAlive) {
      this.spawnEnemy(this.spawnQueue.shift()!);
      this.spawnTimer = Math.max(0.22, 0.95 - this.wave * 0.06);
    }
    if (this.spawnQueue.length === 0 && this.enemies.length === 0) {
      this.events.push({ k: 'clear', n: this.wave });
      // ウェーブクリア：生存者はHP回復、死亡者は復帰
      const anchor = this.players.find((p) => p.status === 'alive');
      for (const p of this.players) {
        if (p.status === 'alive') {
          p.hp = Math.min(p.maxHp, p.hp + PLAYER.waveHeal);
        } else if (p.status === 'dead' && anchor) {
          p.status = 'alive';
          p.hp = p.maxHp * PLAYER.reviveHpRatio;
          p.x = anchor.x;
          p.y = anchor.y;
          moveCircle(p, 30, 0, PLAYER.radius);
          this.events.push({ k: 'revive', id: p.id, x: p.x, y: p.y });
        }
      }
      this.wave++;
      this.phase = 'intermission';
      this.phaseTimer = 4;
    }
  }

  private startWave(): void {
    this.phase = 'combat';
    this.phaseTimer = 0;
    const n = this.wave;
    const mult = 1 + 0.35 * (this.players.length - 1);
    const total = Math.round((4 + n * 3) * mult);
    const tanks = n >= 3 ? Math.floor((n - 1) / 2) : 0;
    const shooters = n >= 2 ? Math.floor(total * 0.3) : 0;
    const chasers = Math.max(1, total - tanks - shooters);
    const q: EnemyType[] = [];
    for (let i = 0; i < chasers; i++) q.push('chaser');
    for (let i = 0; i < shooters; i++) q.push('shooter');
    for (let i = 0; i < tanks; i++) q.push('tank');
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.spawnQueue = q;
    this.spawnTimer = 0.4;
    this.events.push({ k: 'wave', n });
  }

  private spawnEnemy(type: EnemyType): void {
    const st = ENEMY[type];
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 30; tries++) {
      const edge = Math.floor(Math.random() * 4);
      const m = 50;
      x = edge === 0 ? m : edge === 1 ? WORLD_W - m : m + Math.random() * (WORLD_W - m * 2);
      y = edge === 2 ? m : edge === 3 ? WORLD_H - m : m + Math.random() * (WORLD_H - m * 2);
      if (circleHitsObstacle(x, y, st.radius + 4)) continue;
      const near = this.players.some(
        (p) => p.status !== 'dead' && Math.hypot(p.x - x, p.y - y) < 520,
      );
      if (!near) break;
    }
    const n = this.wave;
    const hp = st.hp * (1 + 0.15 * (n - 1));
    this.enemies.push({
      id: this.nextId++,
      type,
      x,
      y,
      angle: 0,
      hp,
      maxHp: hp,
      flash: 0,
      kx: 0,
      ky: 0,
      fireCd: SHOOTER.fireInterval * (0.5 + Math.random()),
      contactCd: 0,
      strafe: Math.random() < 0.5 ? 1 : -1,
      strafeT: 1 + Math.random() * 2,
      speedMul: Math.min(1.45, 1 + 0.035 * (n - 1)) * (0.9 + Math.random() * 0.2),
      dead: false,
    });
  }

  // ---------------- プレイヤー ----------------

  private updatePlayer(p: SimPlayer, dt: number): void {
    // ゲストから届いた入力を到着順に全て適用（各入力の dt で積分）
    for (const f of p.queue) {
      stepMovement(p, f, f.dt, p.status);
      p.ack = f.seq;
      p.aim = f.aim;
      p.shoot = f.shoot;
      p.revive = f.revive;
    }
    p.queue.length = 0;

    if (p.status === 'down') {
      // 蘇生中はカウントダウン停止
      if (p.reviveProgress <= 0) p.downTimer -= dt;
      if (p.downTimer <= 0) {
        p.status = 'dead';
        p.downTimer = 0;
        p.reviveProgress = 0;
        this.events.push({ k: 'dead', id: p.id });
      }
      return;
    }
    if (p.status !== 'alive') return;

    p.fireCd -= dt;
    if (p.shoot) {
      while (p.fireCd <= 0) {
        this.firePlayerBullet(p);
        p.fireCd += PLAYER.fireInterval;
      }
    } else if (p.fireCd < 0) {
      p.fireCd = 0;
    }
  }

  private firePlayerBullet(p: SimPlayer): void {
    const a = p.aim + (Math.random() - 0.5) * 2 * PLAYER.spread;
    this.bullets.push({
      id: this.nextId++,
      team: 'p',
      owner: p.id,
      x: p.x + Math.cos(p.aim) * PLAYER.muzzle,
      y: p.y + Math.sin(p.aim) * PLAYER.muzzle,
      vx: Math.cos(a) * PLAYER.bulletSpeed,
      vy: Math.sin(a) * PLAYER.bulletSpeed,
      life: PLAYER.bulletLife,
      damage: PLAYER.bulletDamage,
      radius: PLAYER.bulletRadius,
      dead: false,
    });
    p.shots++;
  }

  private updateRevive(dt: number): void {
    for (const d of this.players) {
      if (d.status !== 'down') continue;
      const reviver = this.players.find(
        (p) =>
          p !== d &&
          p.status === 'alive' &&
          p.revive &&
          Math.hypot(p.x - d.x, p.y - d.y) <= PLAYER.reviveRange,
      );
      if (reviver) {
        d.reviveProgress += dt;
        if (d.reviveProgress >= PLAYER.reviveTime) {
          d.status = 'alive';
          d.hp = d.maxHp * PLAYER.reviveHpRatio;
          d.reviveProgress = 0;
          d.downTimer = 0;
          this.events.push({ k: 'revive', id: d.id, x: d.x, y: d.y });
        }
      } else {
        d.reviveProgress = Math.max(0, d.reviveProgress - dt * 1.5);
      }
    }
  }

  private damagePlayer(p: SimPlayer, dmg: number): void {
    if (p.status !== 'alive') return;
    p.hp -= dmg;
    this.events.push({ k: 'phit', id: p.id });
    this.events.push({ k: 'dmg', x: p.x, y: p.y - 20, v: dmg, p: true });
    if (p.hp <= 0) {
      p.hp = 0;
      p.status = 'down';
      p.downTimer = PLAYER.downTime;
      p.reviveProgress = 0;
      p.shoot = false;
      p.dashTime = 0;
      this.events.push({ k: 'down', id: p.id, x: p.x, y: p.y });
    }
  }

  private nearestAlive(x: number, y: number): SimPlayer | null {
    let best: SimPlayer | null = null;
    let bd = Infinity;
    for (const p of this.players) {
      if (p.status !== 'alive') continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  // ---------------- 敵AI ----------------

  private updateEnemy(e: SimEnemy, dt: number): void {
    const st = ENEMY[e.type];
    e.flash = Math.max(0, e.flash - dt);
    e.contactCd = Math.max(0, e.contactCd - dt);
    const target = this.nearestAlive(e.x, e.y);
    let dx = 0;
    let dy = 0;

    if (target) {
      const tx = target.x - e.x;
      const ty = target.y - e.y;
      const d = Math.hypot(tx, ty) || 1;
      const ux = tx / d;
      const uy = ty / d;
      const los = hasLineOfSight(e.x, e.y, target.x, target.y);

      if (e.type === 'shooter') {
        if (!los || d > SHOOTER.preferMax) {
          dx = ux;
          dy = uy;
        } else if (d < SHOOTER.preferMin) {
          dx = -ux;
          dy = -uy;
        } else {
          dx = -uy * e.strafe * 0.8;
          dy = ux * e.strafe * 0.8;
        }
        e.strafeT -= dt;
        if (e.strafeT <= 0) {
          e.strafe *= -1;
          e.strafeT = 1.5 + Math.random() * 2;
        }
        e.fireCd -= dt;
        if (los && d < SHOOTER.range && e.fireCd <= 0) {
          this.fireEnemyBullet(e, Math.atan2(ty, tx));
          e.fireCd = SHOOTER.fireInterval * (0.75 + Math.random() * 0.5);
        }
        e.angle = Math.atan2(ty, tx);
      } else {
        dx = ux;
        dy = uy;
      }

      // 視線が通らない場合は遮蔽物を回り込む
      if (!los && dx * ux + dy * uy > 0) {
        const block = firstBlocking(e.x, e.y, target.x, target.y);
        if (block) {
          const cx = block.x + block.w / 2;
          const cy = block.y + block.h / 2;
          let txn = -dy;
          let tyn = dx;
          if (txn * (cx - e.x) + tyn * (cy - e.y) > 0) {
            txn = -txn;
            tyn = -tyn;
          }
          dx = dx * 0.35 + txn;
          dy = dy * 0.35 + tyn;
          const l = Math.hypot(dx, dy) || 1;
          dx /= l;
          dy /= l;
        }
      }

      // 接触ダメージ（チェイサー・タンク）
      if (e.type !== 'shooter' && e.contactCd <= 0) {
        for (const p of this.players) {
          if (p.status !== 'alive') continue;
          const pd = Math.hypot(p.x - e.x, p.y - e.y);
          if (pd < st.radius + PLAYER.radius + 2) {
            this.damagePlayer(p, st.damage);
            e.contactCd = e.type === 'tank' ? 1.0 : 0.7;
            const kx = (e.x - p.x) / (pd || 1);
            const ky = (e.y - p.y) / (pd || 1);
            e.kx += kx * 380 * st.knockResist;
            e.ky += ky * 380 * st.knockResist;
            break;
          }
        }
      }
    }

    if (e.type === 'tank') e.angle += dt * 0.7;
    else if (e.type === 'chaser' && (dx || dy)) e.angle = Math.atan2(dy, dx);

    const sp = st.speed * e.speedMul;
    const decay = Math.exp(-5 * dt);
    e.kx *= decay;
    e.ky *= decay;
    moveCircle(e, (dx * sp + e.kx) * dt, (dy * sp + e.ky) * dt, st.radius);
  }

  private separateEnemies(): void {
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const a = es[i];
      const ra = ENEMY[a.type].radius;
      for (let j = i + 1; j < es.length; j++) {
        const b = es[j];
        const rb = ENEMY[b.type].radius;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = ra + rb + 2;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (min - d) / 2;
          const nx = dx / d;
          const ny = dy / d;
          // 大型ほど押されにくい
          const wa = rb / (ra + rb);
          const wb = ra / (ra + rb);
          a.x -= nx * push * wa * 2;
          a.y -= ny * push * wa * 2;
          b.x += nx * push * wb * 2;
          b.y += ny * push * wb * 2;
        }
      }
    }
  }

  private fireEnemyBullet(e: SimEnemy, angle: number): void {
    const r = ENEMY[e.type].radius + 4;
    this.bullets.push({
      id: this.nextId++,
      team: 'e',
      owner: e.id,
      x: e.x + Math.cos(angle) * r,
      y: e.y + Math.sin(angle) * r,
      vx: Math.cos(angle) * SHOOTER.bulletSpeed,
      vy: Math.sin(angle) * SHOOTER.bulletSpeed,
      life: SHOOTER.bulletLife,
      damage: ENEMY.shooter.damage,
      radius: SHOOTER.bulletRadius,
      dead: false,
    });
    this.events.push({ k: 'eshot', x: e.x, y: e.y, a: angle });
  }

  private damageEnemy(e: SimEnemy, dmg: number, owner: number, dirX: number, dirY: number): void {
    if (e.dead) return;
    const st = ENEMY[e.type];
    e.hp -= dmg;
    e.flash = 0.08;
    const l = Math.hypot(dirX, dirY) || 1;
    e.kx += (dirX / l) * 120 * st.knockResist;
    e.ky += (dirY / l) * 120 * st.knockResist;
    this.events.push({ k: 'dmg', x: e.x, y: e.y - st.radius, v: Math.round(dmg), p: false });
    if (e.hp <= 0) this.killEnemy(e, owner);
  }

  private killEnemy(e: SimEnemy, owner: number): void {
    e.dead = true;
    const st = ENEMY[e.type];
    const killer = this.players.find((p) => p.id === owner);
    if (killer) killer.kills++;
    this.events.push({ k: 'kill', x: e.x, y: e.y, c: st.color, r: st.radius });
    if (e.type === 'tank') this.explode(e.x, e.y, owner);
  }

  /** タンク撃破時の小爆発：周囲の敵を吹き飛ばしダメージ */
  private explode(x: number, y: number, owner: number): void {
    this.events.push({ k: 'boom', x, y, r: TANK_EXPLOSION.radius });
    for (const o of this.enemies) {
      if (o.dead) continue;
      const dx = o.x - x;
      const dy = o.y - y;
      const d = Math.hypot(dx, dy);
      if (d > TANK_EXPLOSION.radius) continue;
      const f = 1 - d / TANK_EXPLOSION.radius;
      const nx = d > 0 ? dx / d : 1;
      const ny = d > 0 ? dy / d : 0;
      const resist = ENEMY[o.type].knockResist;
      o.kx += nx * TANK_EXPLOSION.force * f * Math.max(0.4, resist);
      o.ky += ny * TANK_EXPLOSION.force * f * Math.max(0.4, resist);
      this.damageEnemy(o, TANK_EXPLOSION.damage * (0.5 + f * 0.5), owner, nx, ny);
    }
  }

  // ---------------- 弾 ----------------

  private updateBullets(dt: number): void {
    for (const b of this.bullets) {
      if (b.dead) continue;
      // 2分割サブステップで壁抜けを防ぐ
      for (let s = 0; s < 2 && !b.dead; s++) {
        b.x += (b.vx * dt) / 2;
        b.y += (b.vy * dt) / 2;
        if (b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) {
          b.dead = true;
          break;
        }
        if (pointInObstacle(b.x, b.y)) {
          b.dead = true;
          this.events.push({ k: 'wall', x: b.x - b.vx * 0.006, y: b.y - b.vy * 0.006, o: b.team === 'p' ? b.owner : -1 });
          break;
        }
        if (b.team === 'p') {
          for (const e of this.enemies) {
            if (e.dead) continue;
            const r = ENEMY[e.type].radius + b.radius;
            if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < r * r) {
              b.dead = true;
              this.events.push({ k: 'hit', x: b.x, y: b.y, c: ENEMY[e.type].color, o: b.owner });
              this.damageEnemy(e, b.damage, b.owner, b.vx, b.vy);
              break;
            }
          }
        } else {
          for (const p of this.players) {
            if (p.status !== 'alive') continue;
            const r = PLAYER.radius + b.radius;
            if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 < r * r) {
              b.dead = true;
              this.damagePlayer(p, b.damage);
              break;
            }
          }
        }
      }
      b.life -= dt;
      if (b.life <= 0) b.dead = true;
    }
  }
}
