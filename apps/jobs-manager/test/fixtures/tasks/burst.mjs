// Writes 50 lines as fast as it can and exits at once: the end of the output and the exit race.
for (let i = 1; i <= 50; i++) console.log(JSON.stringify({ i }));
