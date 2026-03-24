
import csv
import json
import os
with open('2022PlayerRatingsWithTeams.csv', 'r') as f:
    reader = csv.reader(f)
    players = list(reader)

playerList = []
playerNumber = 0
for n in players:
    if(playerNumber <1):
        playerNumber += 1
    else:
        dump = {
        "id":int(playerNumber),
        "teamID": players[playerNumber][0],
        "bid":players[playerNumber][1],
        "name":players[playerNumber][2]+" "+ players[playerNumber][3],
        "battingIQ":int(players[playerNumber][8]),
        "timing":int(players[playerNumber][9]),
        "power":int(players[playerNumber][10]),
        "running":int(players[playerNumber][11]),
        "economy":int(players[playerNumber][14]),
        "wicketTaking":int(players[playerNumber][13]),
        "accuracy":int(players[playerNumber][15]),
        "clutch":int(players[playerNumber][16]),
        "country":players[playerNumber][4],
        "age":int(players[playerNumber][5])
        }
        playerList.append(dump)
        playerNumber = playerNumber+1
print(json.dumps(playerList))
with open('cricketPlayerList2022WithTeams.js', 'w') as outfile:
    json.dump(playerList, outfile)