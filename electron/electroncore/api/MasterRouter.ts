import { writeFile } from 'fs';
import { BrowserWindow, IpcMain, ipcMain, Notification } from 'electron';
import { io, Socket } from 'socket.io-client';
import { JSDOM } from 'jsdom';

import { LiveFire } from '../engine/LiveFire';
import { Test } from '../engine/Test';
import Getter from '../engine/Getter';

import {
  QuestionInterface,
  TestInterface,
  UserAnswer,
} from '../helpers/testInteraces';
import {
  PBCall,
  Mode,
  ServerCallbacks,
  ServerMode,
  PVCall,
} from '../helpers/routerInterfaces';

export class MasterRouter {
  getterEngine: Getter;
  LiveFireEngine: LiveFire;
  bWin: BrowserWindow;
  ipc: IpcMain;
  mainTest: Test;
  socket: Socket;
  username: string;
  testName: string;
  operatingMode: Mode;
  serverMode: ServerMode;
  socketRegistered: boolean;

  constructor(window: BrowserWindow) {
    this.ipc = ipcMain;
    this.bWin = window;
    this.socketRegistered = false;
    this.getterEngine = new Getter();

    //Settings handlers

    this.ipc.handle('customChromePath', (e, path: string) => {
      return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
          this.getterEngine.setCustomPathToChrome(path);
          resolve(null);
        } else {
          reject('This option is for Windows Only!!!');
        }
      });
    });

    //Server & Mode section handlers
    this.ipc.handle('mode', (e: any, mode: Mode) => {
      this.operatingMode = mode;
    });

    this.ipc.handle('connectSocket', (e: any, URL: string) => {
      this.registerSocket(URL);
    });

    this.ipc.handle('login', async (e: any, apiORUsername: string) => {
      console.log(apiORUsername);
      if (this.serverMode === ServerMode.PUBLIC) {
        return this.publicLogin(apiORUsername);
      } else if (this.serverMode === ServerMode.PRIVATE) {
        return this.privateLogin(apiORUsername);
      } else {
        return new Promise((_, reject) => {
          reject('Internal server Error');
        });
      }
    });

    //Test handlers
    this.ipc.handle('tests', () => {
      return new Promise((resolve, reject) => {
        this.socket.emit('getTests', (tests: Array<String>) => {
          resolve(tests);
        });
      });
    });

    this.ipc.handle('JoinTest', (e: any, testName: string) => {
      return new Promise((resolve, reject) => {
        if (!this.socket) {
          reject('You are not connected');
        }
        this.socket.emit('JoinTest', testName, async (status: any) => {
          if (status.status === ServerCallbacks.OK) {
            this.mainTest = new Test(status.test);
            this.testName = testName;
            console.log(this.testName);
            this.multiTestTunel();
            resolve(ServerCallbacks.OK);
          } else {
            reject(status.reason);
          }
        });
      });
    });

    this.ipc.handle(
      'registerTest',
      (e: any, testURL: string, testName: string) => {
        return new Promise((resolve, reject) => {
          this.getterEngine.removeAllListeners();
          const splitedName = testName.split(' ');
          if (
            splitedName[splitedName.length - 1].toLowerCase() === 'livefire'
          ) {
            console.log('here1');
            const testID = testURL.split('=')[1];
            const fakeTest: TestInterface = {
              id: testID,
              numberOfQuestions: 0,
              questions: [],
            };
            this.mainTest = new Test(fakeTest);
            if (this.operatingMode === Mode.SINGLE) {
              this.singleRegister().then((res) => resolve(res));
            } else if (this.operatingMode === Mode.MULTI) {
              this.multiRegister(testName)
                .then((result) => {
                  resolve(result);
                })
                .catch((err) => {
                  reject(err);
                });
            }
          } else {
            this.getterEngine.getTest(testURL);
          }
          this.getterEngine.on('status', (status: string) => {
            this.bWin.webContents.send('getter-status', status);
          });
          this.getterEngine.on('error', (err: string) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const myNotification = new Notification({
              title: 'Error from Getter',
              body: err,
            }).show();
            if (err !== 'Panic Mode') {
              reject(err);
            }
          });
          this.getterEngine.on('ready', (test: Test) => {
            this.mainTest = test;
            if (this.operatingMode === Mode.SINGLE) {
              this.singleRegister().then((res) => resolve(res));
            } else if (this.operatingMode === Mode.MULTI) {
              this.multiRegister(testName)
                .then((result) => {
                  resolve(result);
                })
                .catch((err) => {
                  reject(err);
                });
            }
          });
        });
      }
    );

    this.ipc.handle('exporTest', (e: any) => {
      if (this.mainTest) {
        const raw: string = JSON.stringify(this.mainTest, null, 4);
        writeFile(`test-${this.testName}.json`, raw, (err) => {
          if (err) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const error = new Notification({
              title: 'Error from Export',
              body: err.toString(),
            }).show();
          } else {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const saved = new Notification({
              title: 'Test Exported',
              body: 'Test Exported',
            }).show();
          }
        });
      }
    });

    //Leave handler
    this.ipc.handle('leave', () => {
      this.leave();
    });
  }

  //This must be here bcs bwindow emit every f**king time event ready-to-show and show when open devTools
  public initLiveFireAndCustomChrome() {
    if (!this.LiveFireEngine) {
      this.LiveFireEngine = new LiveFire();
      this.liveFireConnection();

      //On startup check user defined path to Crome engine
      this.bWin.webContents
        .executeJavaScript('localStorage.getItem(`chromePath`);', true)
        .then((path) => {
          if (path !== '') {
            this.getterEngine.setCustomPathToChrome(path);
          }
        });
    }

    console.log('Hahahaha');
  }

  private singleRegister() {
    return new Promise((resolve, reject) => {
      this.singleTestTunel();
      resolve(ServerCallbacks.OK);
    });
  }

  private multiRegister(testName: string) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject('You are not connected');
      }
      const name = `${testName}#${this.mainTest.ID}`;
      const rawTest: TestInterface = {
        id: this.mainTest.ID,
        numberOfQuestions: this.mainTest.numberOfQuestions,
        questions: this.mainTest.questions,
      };
      this.socket.emit(
        'registerTest',
        testName,
        JSON.stringify(rawTest),
        (status: PBCall | PVCall) => {
          if (status.status === ServerCallbacks.OK) {
            this.testName = name;
            this.multiTestTunel();
            resolve(ServerCallbacks.OK);
          } else {
            reject(status.reason);
          }
        }
      );
    });
  }

  private publicLogin(uName: string) {
    return new Promise((resolve, reject) => {
      if (this.socketRegistered) {
        this.socket.emit('login', uName, async (status: PBCall) => {
          if (status.status === ServerCallbacks.OK) {
            this.username = uName;
            resolve(uName);
          } else {
            reject(status.reason);
          }
        });
      } else {
        reject('Socket is not registered');
      }
    });
  }

  private privateLogin(apiKey: string) {
    return new Promise((resolve, reject) => {
      if (this.socketRegistered) {
        this.socket.emit('login', apiKey, async (status: PVCall) => {
          if (status.status === ServerCallbacks.OK) {
            this.username = status.username;
            resolve(status.username);
          } else {
            reject(status.reason);
          }
        });
      } else {
        reject('Socket is not registered');
      }
    });
  }

  //TODO: Rewrite some listeners answerAddwd answerDeleted
  private singleTestTunel() {
    this.ipc.handle('test', async () => {
      return this.mainTest.cleanTest();
    });

    this.ipc.handle(
      'answerAdded',
      (e: any, answer: UserAnswer, questID: number) => {
        this.mainTest.addAnswer(answer, questID);
      }
    );
    this.mainTest.on('answerAdded', (q: QuestionInterface) => {
      this.bWin.webContents.send('answerAdded', q);
      if (
        this.LiveFireEngine?.currentQuest === q.id &&
        this.LiveFireEngine?.testId === this.mainTest.ID
      ) {
        this.LiveFireEngine?.answer(q.UsersAnswers);
      }
    });
    this.ipc.handle(
      'answerDeleted',
      (e: any, username: string, questID: number) => {
        this.mainTest.removeAnswer(username, questID);
      }
    );
    this.mainTest.on('answerDeleted', (q: QuestionInterface) => {
      this.bWin.webContents.send('answerDeleted', q);
    });

    this.mainTest.on('questionAdded', (quest: QuestionInterface) => {
      this.bWin.webContents.send('questionAdded', this.mainTest.cleanTest());
    });

    this.registerLiveFire();
  }

  private multiTestTunel() {
    this.ipc.handle('test', async () => {
      return this.mainTest.cleanTest();
    });

    this.ipc.handle(
      'answerAdded',
      (e: any, answer: UserAnswer, questID: number) => {
        console.log(answer);
        const prepAnswer: UserAnswer = {
          username: this.username,
          answer: answer.answer,
        };
        this.mainTest.addAnswer(answer, questID);
        this.socket.emit(
          'addAnswer',
          this.testName,
          questID,
          JSON.stringify(prepAnswer)
        );
      }
    );

    this.mainTest.on('answerAdded', (q: QuestionInterface) => {
      this.bWin.webContents.send('answerAdded', q);
      if (
        this.LiveFireEngine.currentQuest === q.id &&
        this.LiveFireEngine.testId === this.mainTest.ID
      ) {
        this.LiveFireEngine.answer(q.UsersAnswers);
      }
    });

    this.socket.on('addedAnswer', (questID: string, rawAnswer: string) => {
      const answer: UserAnswer = JSON.parse(rawAnswer);
      this.mainTest.addAnswer(answer, +questID);
    });

    this.mainTest.on('questionAdded', (quest: QuestionInterface) => {
      this.bWin.webContents.send('questionAdded', this.mainTest.cleanTest());
      this.socket.emit('questionAdded', this.testName, quest);
      console.log(quest);
    });

    this.registerLiveFire();
  }

  //Handle connection status from LiveFire
  private liveFireConnection() {
    this.LiveFireEngine.on('liveFireStatus', (status: string) => {
      this.bWin.webContents.send('liveStatus', status);
    });
  }

  private registerLiveFire() {
    this.LiveFireEngine.on('quest', (raw: string) => {
      if (this.LiveFireEngine.testId === this.mainTest.ID) {
        const rawQuest: any = new JSDOM(raw);
        const quest: QuestionInterface = this.getterEngine.scrap(
          Array.from(
            rawQuest.window.document.querySelector('.question-container')
              .children
          )
        );
        this.LiveFireEngine.currentQuest = quest.id;
        const mainTestQuest = this.mainTest.questions.find(
          (q) => q.id === quest.id
        );
        if (mainTestQuest) {
          this.bWin.webContents.send('focus', quest.id);
          this.LiveFireEngine.answer(mainTestQuest.UsersAnswers);
        } else {
          this.mainTest.addQuestion(quest);
        }
      }
    });
  }

  registerSocket(URL: string) {
    //finaly some good fu*** food
    if (this.socket) {
      // this.socket.offAny()
      console.log('hello');
      // this.socket.close()
      delete this.socket;
    }
    const o: any = { reconnection: false };
    this.socket = io(URL, o);

    this.socket.on('connect', () => {
      this.socketRegistered = true;
      console.log(this.socketRegistered);
    });

    this.socket.on('serverMode', (sM: ServerMode) => {
      this.serverMode = sM;
      this.bWin.webContents.send('socketStatus', {
        status: 'Ok',
        mode: this.serverMode,
      });
      console.log(this.serverMode);
    });

    this.socket.on('disconnect', (reason: string) => {
      if (this.socket) {
        this.bWin.webContents.send('socketStatus', { status: 'error', reason });
        this.bWin.webContents.send('socketStatusError', {
          status: 'error',
          reason,
        });
        this.socketRegistered = false;
        console.log('hello1');
        this.socket.close();
        delete this.socket;
      }
    });

    this.socket.on('connect_error', (error: any) => {
      this.bWin.webContents.send('socketStatus', {
        status: 'error',
        reason: 'connect_error',
      });
      this.bWin.webContents.send('socketStatusError', {
        status: 'error',
        reason: 'connect_error',
      });
      this.socketRegistered = false;
      console.log('hello2');
      this.socket.close();
      delete this.socket;
    });

    this.socket.on('addedAnswer', (questID: string, rawAnswer: string) => {
      if (this.mainTest) {
        const answer: UserAnswer = JSON.parse(rawAnswer);
        this.mainTest.addAnswer(answer, +questID);
      }
    });
    this.socket.on('addedQuestion', (rawQuest: string) => {
      if (this.mainTest) {
        console.log(rawQuest);
        const question: QuestionInterface = JSON.parse(rawQuest);
        this.mainTest.addQuestion(question);
      }
    });
  }

  //------------------------------------------------------->

  leave() {
    if (this.socket) {
      this.socket.emit('leave');
    }

    this.ipc.removeHandler('answerAdded');
    this.ipc.removeHandler('answerDeleted');
    this.ipc.removeHandler('test');
    this.ipc.removeAllListeners('quest');

    this.LiveFireEngine.removeAllListeners();
  }
}
