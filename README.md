# Positron Tanks

This is a game that simulates battles between robotic vehicles (the "tanks" in question) controlled entirely via programs. The programs themselves are not AI, but they can be written by an AI or written by a human.

You can design maps, the bots themselves (by assembling a number of components, up to a point budget set for each game), and the programs that run them.

Programs are written in a small JavaScript-flavoured language, with a variety of functions for moving, firing weapons, checking sensors, and so on.

You can run a server locally to test your designs and programs and maps. You can also run a server in the cloud (we use Pulumi, right now set up to deploy to AWS, though it could be adapted to deploy to Azure or elsewhere) to play against your friends (or enemies). See `docs/docker.md` and `docs/deployment.md`.

## Set Up

The easiest way to set up is to install the Claude Code plugin. Claude then takes care of the rest for you!

```
/plugin marketplace add GinNGravitonic/positrontanks
/plugin install positron-tanks@positron-tanks
```

This plugin includes several skills. Once installed, each is named with the plugin's prefix, such as `/positron-tanks:play-positron-tanks`:

* `play-positron-tanks` - this skill will check out the repo locally on your machine, build the game and its command-line tool, start a local server, and explain to the agent how to use all the features of the game.
* `create-map` - use this skill to have your agent help you create a new map to battle on.
* `create-bot-design` - use this skill to have your agent help you create a new bot.
* `write-program` - use this skill to have your agent help you write a program to drive your bot.
* `improve-by-self-play` - this skill explains to an agent how to iteratively improve a bot by playing against itself.

See `docs/plugin.md` for more details.

## Maps and Bot Components

Refer to `packages/ruleset-data/spec/r1/catalog-r1.md` for more information.

### Maps

Maps have different terrain types you can put on them: grass, road, sand, mud, and ice. They each affect the speed and acceleration of your bot. Maps can also have obstacles, some of them destructible, that block both movement and weapons fire. Maps also have spawn zones where bots will be placed at the start of a battle.

### Components

When constructing a bot, you select a chassis first - they have different masses, different strengths, different slots (to install weapons and other components) and most critically different costs.

Whoever sets up a game chooses a point budget for it (between 100 and 800 points under the current ruleset). Your entry has to come in under that budget to be admitted to the game. But you don't need to just enter a single bot. If the budget is 800, you could enter a single bot that costs that much, sure. But you can also enter 2 bots into the game as long as their combined cost doesn't break the budget (for example, one bot that costs 500 and one that costs 300). You can even enter more than 2, and they can work together or each hunt on their own. (Be careful, though: your bots can damage each other.)

After you select a chassis, you select components to plug into the various slots: weapons, sensors, motors, and processors. Every chassis comes with a basic processor, so a better one is optional. Separately, you can buy armor for each side of the bot (front, left, right, and rear).

## Writing Programs

Refer to `packages/ruleset-data/spec/r1/language-r1.md` for more information.

## Battles

The engine that runs battles runs each bot's program once per "tick" (the tick rate is set by the ruleset; the current ruleset uses 10 ticks per simulated second). Programs have a specific operation budget per tick, set by the bot's processor, and cannot run forever. The program can read sensors, move the bot, or fire weapons.

### Starting A Battle

The quickest way to try out a battle is to run one locally from files, with no server or account needed. You give it a map and one entry file per player (each entry file lists that player's bots, their builds and their programs):

```bash
positrontanks run --map packages/ruleset-data/maps/duel.json \
  --entry packages/cli/examples/alice.entry.json \
  --entry packages/cli/examples/bob.entry.json --unthrottled
```

Without `--unthrottled`, the battle plays out in real time (one simulated second per real second).

To play against other people, you use a server. One player creates a game, choosing the map, the number of players, the point budget and the time limit:

```bash
positrontanks games create --map <MAP_ID> --players 2 --point-budget 300 --time-limit 120
```

Other players can find open games with `positrontanks games browse`, and enter one with the bots they want to field from their saved designs:

```bash
positrontanks games enter <GAME_ID> --bot Rex=<DESIGN_ID> --bot Fido=<DESIGN_ID>
```

The battle starts automatically as soon as the game is full. If it doesn't fill up in time (an hour by default), it is cancelled.

### Watching A Battle

There is no graphical viewer yet, so watching a battle happens through the command-line tool. Once a game is running, anyone signed in to the server can follow it:

```bash
positrontanks games watch <GAME_ID>
```

This prints each bot as it is disabled, and the result at the end. Add `--wait` to start watching a game that hasn't started yet, and `--out <FILE>` to save the replay as you go.

After a game ends, `positrontanks games replay <GAME_ID>` fetches the full replay: every event in the battle, plus every bot's build (but never its program). And `positrontanks games logs <GAME_ID>` shows the program logs for your own bots - runtime errors, operation counts, and anything your programs printed with `log()` - which is the best way to work out why your bot did what it did.
