import type { Logging } from 'homebridge';

import type { DeskController } from './deskController.js';

function describeHeight(desk: DeskController): string {
  const height = desk.floorHeightMm;
  return height === undefined ? 'an unknown height' : `${height} mm`;
}

export interface Favourite {
  /** Unique across the platform; also the HAP service subtype. */
  key: string;
  /** What the user called it, used in log messages. */
  label: string;
  /** Height above the floor, in millimetres. */
  heightMm: number;
  deskIds: string[];
  toleranceMm: number;
  moveTimeoutMs: number;
  /** Pushes the switch state back to HomeKit. */
  setSwitch(on: boolean): void;
}

/**
 * Owns which favourite is currently "on".
 *
 * Apple Home has no notion of a radio group, so exclusivity is enforced here:
 * switching a favourite on switches off every other favourite that touches one
 * of the same desks, including group favourites. After the move is issued the
 * desks are watched until they either arrive or stop somewhere else, and a
 * favourite that did not get there switches itself back off.
 */
export class FavouriteCoordinator {
  private readonly favourites = new Map<string, Favourite>();
  private readonly active = new Set<string>();
  /** Desks with a move in flight, so drift checks do not fire mid-move. */
  private readonly moving = new Map<string, number>();
  private generation = 0;

  constructor(
    private readonly desks: Map<string, DeskController>,
    private readonly log: Logging,
  ) {}

  register(favourite: Favourite): void {
    this.favourites.set(favourite.key, favourite);
  }

  /**
   * Starts watching a desk for drift. A favourite stays on only while its desks
   * are actually resting at its height, so moving a desk by hand, or from
   * another favourite, clears the switch.
   */
  watch(desk: DeskController): void {
    desk.on('settled', () => this.reviewAfterSettle(desk));
    desk.on('state', () => {
      if (!desk.reachable) {
        this.clearFavouritesFor(desk.id, 'the desk went offline');
      }
    });
  }

  isActive(key: string): boolean {
    return this.active.has(key);
  }

  /**
   * Switching a favourite off has no physical meaning, so it only clears the
   * switch; the desk stays where it is.
   */
  deactivate(key: string): void {
    this.active.delete(key);
  }

  /**
   * Issues the move and returns as soon as the commands are published, so the
   * HomeKit write completes promptly. Verification continues in the background
   * and switches the favourite back off if the desks did not arrive.
   */
  activate(key: string): void {
    const favourite = this.favourites.get(key);
    if (favourite === undefined) {
      return;
    }

    this.clearConflicting(favourite);
    this.active.add(key);

    const generation = ++this.generation;
    const targets: DeskController[] = [];
    const failures: string[] = [];

    for (const deskId of favourite.deskIds) {
      const desk = this.desks.get(deskId);
      if (desk === undefined) {
        failures.push(`${deskId} is not configured`);
        continue;
      }
      const result = desk.moveToFloorHeightMm(favourite.heightMm);
      if (result.ok) {
        this.moving.set(deskId, generation);
        targets.push(desk);
      } else {
        failures.push(`${desk.name}: ${result.reason}`);
      }
    }

    if (failures.length > 0) {
      this.log.error(`Favourite ${favourite.label} could not be applied - ${failures.join('; ')}.`);
    }
    if (targets.length === 0) {
      this.fail(favourite, generation);
      return;
    }

    void this.verify(favourite, targets, generation, failures.length > 0);
  }

  private async verify(favourite: Favourite, targets: DeskController[], generation: number, alreadyFailed: boolean): Promise<void> {
    let arrived: boolean[];
    try {
      arrived = await Promise.all(
        targets.map(desk => desk.waitForFloorHeightMm(favourite.heightMm, favourite.toleranceMm, favourite.moveTimeoutMs)),
      );
    } catch (error) {
      this.log.error(`Verifying favourite ${favourite.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      arrived = targets.map(() => false);
    }

    for (const desk of targets) {
      if (this.moving.get(desk.id) === generation) {
        this.moving.delete(desk.id);
      }
    }

    // A newer favourite took over these desks while this one was moving.
    if (generation !== this.generation) {
      return;
    }

    const missed = targets.filter((_, index) => arrived[index] !== true);
    if (missed.length === 0 && !alreadyFailed) {
      this.log.info(`${favourite.label} reached ${favourite.heightMm} mm.`);
      return;
    }

    if (missed.length > 0) {
      const detail = missed.map(desk => `${desk.name} stopped at ${describeHeight(desk)}`).join('; ');
      this.log.warn(`Favourite ${favourite.label} did not reach ${favourite.heightMm} mm - ${detail}. Switching it back off.`);
    }
    this.fail(favourite, generation);
  }

  private fail(favourite: Favourite, generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    this.active.delete(favourite.key);
    favourite.setSwitch(false);
  }

  /** Switches off every active favourite that shares a desk with this one. */
  private clearConflicting(favourite: Favourite): void {
    for (const key of [...this.active]) {
      if (key === favourite.key) {
        continue;
      }
      const other = this.favourites.get(key);
      if (other === undefined) {
        this.active.delete(key);
        continue;
      }
      if (other.deskIds.some(deskId => favourite.deskIds.includes(deskId))) {
        this.active.delete(key);
        other.setSwitch(false);
        this.log.debug(`Switching off ${other.label}, superseded by ${favourite.label}.`);
      }
    }
  }

  private reviewAfterSettle(desk: DeskController): void {
    if (this.moving.has(desk.id)) {
      return;
    }
    for (const key of [...this.active]) {
      const favourite = this.favourites.get(key);
      if (favourite === undefined || !favourite.deskIds.includes(desk.id)) {
        continue;
      }
      if (!desk.isAtFloorHeightMm(favourite.heightMm, favourite.toleranceMm)) {
        this.active.delete(key);
        favourite.setSwitch(false);
        this.log.debug(`Switching off ${favourite.label}, ${desk.name} is now at ${describeHeight(desk)}.`);
      }
    }
  }

  private clearFavouritesFor(deskId: string, reason: string): void {
    for (const key of [...this.active]) {
      const favourite = this.favourites.get(key);
      if (favourite === undefined || !favourite.deskIds.includes(deskId)) {
        continue;
      }
      this.active.delete(key);
      favourite.setSwitch(false);
      this.log.debug(`Switching off ${favourite.label}, ${reason}.`);
    }
  }
}
