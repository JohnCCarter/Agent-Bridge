# Task Contracts

## Status

| Status      | Används när ...                                        |
|-------------|------------------------------------------------------- |
| proposed    | Uppdraget har skapats och väntar på åtgärd             |
| accepted    | Agenten har accepterat uppdraget (valfritt steg)       |
| in_progress | Uppdraget pågår                                        |
| completed   | Uppdraget är färdigt                                   |
| failed      | Uppdraget misslyckades                                 |
| cancelled   | Uppdraget avbröts                                      |

## Historical Entries
Varje kontrakt har en historik med timestamp, actor, status och note. Det första objektet registreras vid skapande. Detta möjliggör revision/logg kring kontraktets livscykel.
