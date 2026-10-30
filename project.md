I have an idea I'd like to explore, which is to create a "battlebots" kind of game purely in software, where opponents would design their bot's structure and weapons via some kind of ruleset, where they get a certain budget of "points" to spend on components. The idea would be that some players might go more towards weapons but this might leave them with less armor, or a slower motor, as an example. These software robots would battle in a simulated environment. They would also have sensors of various kinds available. Players would write small programs in a domain-specific language to run the bot. So a game would declare the total point value of allowed robots, and players would each submit their component list and program. The game itself would then be played fully automatically, and players can monitor the game but not interact with it. The last bot operational would win. There would also be a time limit so that if more than one bot remains after a certain amount of time, perhaps the rule would be that the bot that inflicted the most damage would win.



I'd like to build this entirely as a back end service initially, with no front end. The front end could be built later. But as long as an API exists, it would be possible for LLMs to play against each other (and against human players). I also imagine a single LLM could play against itself, refining designs and bot code until it has a top entrant.



More advanced rules could allow a player to enter multiple bots, which could cooperate. This would require the domain-specific language to allow communication. Perhaps this would be through open messages that all bots can see, so this means players would need to try to obfuscate their coordination messages, and opponents could try to determine how the messages are formatted.



This could be a full physics simulation. Or, it could be more like a strategy board game similar to space battle games like those from FASA in the 1980s.



I think there have also been other games in the past where players create and program software robots, but I don't think there has been a modern recent version.



We'd need to decide on the nature of the game (physics simulation or strategy board game), and then what bot components need to be defined (weapons, motors, sensors, etc). We could determine initial costs for them, but these costs might get modified over time as we balance the game. Then we'd need to define the programming language (which I'd want to be as simple as possible) and make sure it can interact with all of the sensors, motors, weapons, etc. Then we'd need to define how the server would run all of the bots that are entered into a competition. If this is a physics simulation, it would likely need to be realtime (the programming language would need to understand elapsed time) and bots would run in parallel. If this is more like a board game, presumably each bot would be given a turn to make a move or fire a weapon or something similar.



The API would need to have some kind of authentication method, and a player's bots would be stored and only they can access them. I'm thinking that one of the endpoints might be "create an account" and can specify a username and password. In the future, we might want to add an email address and require validation, but we could add that later.



The API should also have endpoints for a parts catalog, and retrieving the rules and the language specification. These all would need versioning, because I imagine the language could evolve and we could still host games with bots that were created for an earlier version.



There should be endpoints for creating a game, and browsing games that are waiting for players. The server would automatically start a game once it has enough bots registered (creating a new game would specify how many players are required and what the time limit for the game is). Created games would also use maps, which would have various obstacles. Perhaps some obstacles would be permanent and some could be destroyed. Right now, all obstacles should be immobile, but in the future we might introduce obstacles that can be pushed. Obstacles need to be routed around, but also can block weapons.



The API should allow creating and retrieving maps. Maps can be read by anyone, but only edited or deleted by their creator. When creating a game, the game "initiator" would select a map.



We might eventually allow creating new components, as well (but not at first), so we need a structured way to define components.



A game could also specify what the maximum allowable point-value for a bot is, so some games might run with heftier bots and some games might run with smaller bots. Actually, now that I think about it, I could imagine this being how multiple bots are allowed. If a game allows a bot of up to 1000 points, for instance, a player could enter with a single 1000-point bot, or enter with two 500-point bots, or with ten 100-point bots, or even a mix of one 500-point bot and five 100-point bots, or other combinations. Each bot in that case needs to be paired with its own program.



Players should be able, via the API, to create a "garage" of pre-created bots. They'd select from their garage when entering a game.



When a game starts, it would notify players (via webhooks that they can set up) that a game has started. It would also notify them when it has ended, with the results. During game play, it should be possible to call endpoints to inspect the current state of play, but no way to interact with the bots (and the bots should not be able to make network calls, because then they might be able to call the inspection endpoint). In the future, this inspection endpoint could be called by a front-end to create a visual display of the battle. I could imagine that there might be more than one endpoint for inspecting an in-progress game. One that lets the caller inspect the state of bots, their position, the state of the map, and so on. Another endpoint might be a long-lived connection where the caller is sent a stream of events.



The most important decision is to determine if this will be a strategy board game or a real-time physics engine.



The game is called "Positron Tanks".





