chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed, loading config...");
  fetch(chrome.runtime.getURL("config.json"))
    .then((response) => {
      console.log("Config fetch response:", response.status);
      return response.json();
    })
    .then((data) => {
      chrome.storage.local.set({ config: data }, () => {
        console.log("Config saved to storage");
        // Initialize config after saving
        initializeConfig();
      });
    })
    .catch((error) => {
      console.error("Error loading config:", error);
    });
});

let bearerToken = "";
let stratzApi = "";
let processedData = "";
let allHeros = "";
let playerBestHeroes = "";

// Function to initialize config variables
async function initializeConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get("config", (data) => {
      bearerToken = data.config?.STRATZ_TOKEN;
      stratzApi = data.config?.STRATZ_GQL;
      console.log("Config loaded:", { bearerToken: !!bearerToken, stratzApi });
      resolve();
    });
  });
}

// Initialize config when the script loads
initializeConfig();

async function makeGraphQLProfileRequest(steamID3) {
  const query = `
  query playerInfo ($steamid: Long!)
  {
    player(steamAccountId: $steamid) {
      firstMatchDate
      matchCount 
      winCount 
      MatchGroupBySteamId: matchesGroupBy( request: {
        take: 5
        gameModeIds: [1,22]
        playerList: SINGLE
        groupBy: STEAM_ACCOUNT_ID
      }) {
        ... on MatchGroupBySteamAccountIdType{ matchCount winCount avgImp avgKills avgDeaths avgAssists avgExperiencePerMinute avgGoldPerMinute avgKDA }
      }
      MatchGroupByHero: matchesGroupBy( request: {
        take: 5
        gameModeIds: [1,22]
        playerList: SINGLE
        groupBy: HERO
      }) {
        ... on MatchGroupByHeroType{ heroId matchCount winCount avgKills avgDeaths avgAssists avgExperiencePerMinute avgGoldPerMinute avgKDA avgImp }
      }
      simpleSummary{
        matchCount
        lastUpdateDateTime
        heroes
        {
          heroId
          winCount
          lossCount
        }
      }
      steamAccount {
        name 
        avatar
        isAnonymous 
        seasonRank 
        smurfFlag
        countryCode
        isDotaPlusSubscriber
        dotaAccountLevel
        seasonLeaderboardRank
        guild{
          guild{
            name
            motd
            logo
            tag
          }
        }
        battlepass{
          level
        }
        proSteamAccount {
          isPro
          name
        }
      }
      matches( request: {
        isParsed: true
        gameModeIds: [1,22]
        take: 5
        playerList: SINGLE
      }) {
        id
        analysisOutcome
        durationSeconds
        endDateTime
        players(steamAccountId: $steamid) { isVictory networth level assists kills deaths heroId experiencePerMinute goldPerMinute }
      }
    }
  }
  `;

  const variables = {
    steamid: steamID3,
  };

  await getRequestAPIStratz(stratzApi, query, variables, "playerInfo");
}

async function makeGraphQLHerosRequest() {
  const query = `
  query GetAllHeroes {
    constants {
      heroes {
        id
        name
        displayName
        shortName
        stats {
          primaryAttribute
        }
      }
    }
  }
  `;
  await getRequestAPIStratz(stratzApi, query, null, "allHeros");
}

async function makeGraphQLGetPlayerBestHeroes(steamID3) {
  const query = `
  query GetPlayerBestHeroes($steamAccountId: Long!,  $take: Int!, $gameVersionId: Short!) {
    player(steamAccountId: $steamAccountId) {
      steamAccountId
      matchCount
      heroesGroupBy: matchesGroupBy(
        request: { playerList: SINGLE, groupBy: HERO, take: $take }
      ) {
        ... on MatchGroupByHeroType {
          heroId
          hero(gameVersionId: $gameVersionId) {
            id
            displayName
            shortName
          }
          winCount
          matchCount
        }
      }
    }
  }
  `;
  const variables = {
    steamAccountId: steamID3,
    take: 50000,
    gameVersionId: 169,
  };

  await getRequestAPIStratz(stratzApi, query, variables, "bestHeroes");
}

async function getRequestAPIStratz(stratzApi, query, variables, type) {
  if (!stratzApi || !bearerToken) {
    console.error("Missing API configuration:", { stratzApi: !!stratzApi, bearerToken: !!bearerToken });
    return;
  }

  try {
    console.log("Making GraphQL request:", { type, stratzApi, hasToken: !!bearerToken });
    const response = await fetch(stratzApi, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    
    if (!response.ok) {
      console.error("HTTP Error:", response.status, response.statusText);
      return;
    }
    
    const data = await response.json();
    processAndSendMessage(data, type);
  } catch (error) {
    console.error("GraphQL Error:", error);
  }
}

function processAndSendMessage(data, type) {
  sendMessageLog(data);
  if (type === "playerInfo") {
    processedData = data?.data?.player;
    // Process and send player data only when we have player info
    processedData = processGraphQLData(data);
    processGraphQLPlayer();
    sendMessageToContentScript(processedData);
  }
  if (type === "bestHeroes") {
    playerBestHeroes = data?.data?.player?.heroesGroupBy.sort(
      (a, b) => b.matchCount - a.matchCount
    );
    // Don't process and send until we have player info
  }
}

function processGraphQLPlayer() {
  // Add best heroes data to processedData if available
  if (playerBestHeroes && processedData) {
    processedData.bestHeroes = playerBestHeroes.slice(0, 5);
    
    // Calculate winrate for each hero
    if (processedData.bestHeroes) {
      processedData.bestHeroes.forEach((hero) => {
        hero.winrate = (hero.winCount / hero.matchCount) * 100;
      });
    }
  }
  
  console.log("Processed player data:", processedData);
}

function verificarHeroId(heroes, heroId) {
  return heroes.find((hero) => hero.heroId === heroId) || null;
}

function processGraphQLData(data) {
  const playerData = data?.data?.player;
  // Use proSteamAccount name if available, otherwise use playerName
  const playerName =
    (playerData?.steamAccount?.proSteamAccount?.isPro &&
      playerData?.steamAccount?.proSteamAccount?.name) ||
    playerData?.steamAccount?.name ||
    "";

  const processedData = {
    playerName: playerName,
    countryCode: playerData?.steamAccount?.countryCode,
    isPro: playerData?.steamAccount?.proSteamAccount?.isPro || false, // Added isPro field
    isAnonymous: playerData?.steamAccount?.isAnonymous || false,
    seasonRank: playerData?.steamAccount?.seasonRank || "",
    smurfFlag: playerData?.steamAccount?.smurfFlag || false,
    isDotaPlusSubscriber:
      playerData?.steamAccount?.isDotaPlusSubscriber || false,
    seasonLeaderboardRank:
      playerData?.steamAccount?.seasonLeaderboardRank || "",
    matchCount: playerData?.matchCount || 0,
    winCount: playerData?.winCount || 0,
    firstMatchDate: convertTimestampToDate(playerData?.firstMatchDate),
    bestHeroes: playerData?.bestHeroes,
    battlepass_level: playerData?.steamAccount?.battlepass[0]?.level || "",
    guild_name: playerData?.steamAccount?.guild?.guild.name || "",
    guild_desc: playerData?.steamAccount?.guild?.guild.motd || "",
    guild_tag: playerData?.steamAccount?.guild?.guild.tag || "",
  };

  processedData.medalImage = getMedalImage(processedData?.seasonRank);
  processedData.starImage = getStarImage(processedData?.seasonRank);
  processedData.leaderboardMedalImage = getLeaderboardMedalImage(
    processedData?.seasonRank,
    processedData?.seasonLeaderboardRank
  );

  return processedData;
}

function convertTimestampToDate(timestamp) {
  return timestamp ? new Date(timestamp * 1000) : null;
}

function getMedalImage(seasonRank, seasonLeaderboardRank) {
  let imagePath;
  if (seasonRank === 80) {
    imagePath = "images/ranks/medal_8.png";
  } else {
    imagePath = `images/ranks/medal_${Math.floor(seasonRank / 10)}.png`;
  }
  return imagePath;
}

function getStarImage(seasonRank) {
  const parsedSeasonRank = parseInt(seasonRank);
  return parsedSeasonRank &&
    parsedSeasonRank < 80 &&
    parsedSeasonRank % 10 !== 0
    ? `images/ranks/star_${parsedSeasonRank % 10}.png`
    : "";
}

function getLeaderboardMedalImage(seasonRank, seasonLeaderboardRank) {
  const parsedSeasonRank = parseInt(seasonRank);
  const parsedLeaderboardRank = parseInt(seasonLeaderboardRank);

  if (parsedSeasonRank === 80 && !isNaN(parsedLeaderboardRank)) {
    return parsedLeaderboardRank <= 10
      ? "images/ranks/medal_8c.png"
      : parsedLeaderboardRank <= 100
      ? "images/ranks/medal_8b.png"
      : "images/ranks/medal_8.png";
  }

  return "";
}

async function isContentScriptReady(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "ping" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

async function sendMessageToContentScript(data) {
  if (!data) {
    console.log("No data to send to content script");
    return;
  }
  
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    
    if (!tab?.id) {
      console.log("No active tab found");
      return;
    }

    console.log("Checking if content script is ready for tab:", tab.id);
    
    // Check if content script is ready
    const isReady = await isContentScriptReady(tab.id);
    
    if (isReady) {
      console.log("Content script is ready, sending data");
      chrome.tabs.sendMessage(tab.id, { action: "updateDotaStats", data });
    } else {
      console.log("Content script not ready, skipping message send");
    }
    
  } catch (error) {
    console.log("Error sending message to content script:", error);
  }
}

async function sendMessageLog(data) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    
    if (activeTab?.url && 
        (activeTab.url.includes('steamcommunity.com/id/') || 
         activeTab.url.includes('steamcommunity.com/profiles/'))) {
      
      // Send message without expecting a response
      chrome.tabs.sendMessage(activeTab.id, { action: "logData", data: data });
    }
  } catch (error) {
    // Silently ignore errors for log messages
  }
}

chrome.runtime.onMessage.addListener(async function (
  request,
  sender,
  sendResponse
) {
  if (request.action === "fetchDotaStats") {
    // Ensure config is loaded before making API calls
    await initializeConfig();
    
    if (!bearerToken || !stratzApi) {
      console.error("Config not loaded properly:", { bearerToken: !!bearerToken, stratzApi });
      return;
    }
    
    const steamID3 = Number(request.steamID);
    
    try {
      // Reset data
      processedData = "";
      playerBestHeroes = "";
      
      // First get best heroes
      await makeGraphQLGetPlayerBestHeroes(steamID3);
      // Then get player info (this will process and send the final data)
      await makeGraphQLProfileRequest(steamID3);
    } catch (error) {
      console.error("Error fetching Dota stats:", error);
    }
  }
});
